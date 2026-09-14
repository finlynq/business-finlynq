import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run("PostgreSQL Entra MFA assurance", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const organizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO organizations(id,slug,display_name)
       VALUES ($1,$2,'Entra assurance integration')`,
      [organizationId, `entra-${organizationId.slice(0, 12)}`],
    );
    await pool.query(
      `INSERT INTO users(
         id,email_lookup_hash,email_ciphertext,password_hash,email_verified_at
       ) VALUES ($1,$2,'encrypted','!oidc-only!',now())`,
      [userId, `entra-${userId}`],
    );
    await pool.query(
      `INSERT INTO organization_memberships(id,organization_id,user_id)
       VALUES ($1,$2,$3)`,
      [membershipId, organizationId, userId],
    );
  });

  afterAll(async () => pool.end());

  it("keeps missing evidence ordinary and gives trusted evidence session-bounded step-up", async () => {
    async function issue(assurance: "NONE" | "AMR_MFA" | "AUTH_CONTEXT") {
      const result = await pool.query<{ session_id: string }>(
        `SELECT app.auth_issue_oidc_user_session(
           $1,$2,$3,$4,$5,$6,$7,$8,$9
         ) AS session_id`,
        [
          userId, organizationId, membershipId,
          randomUUID().replaceAll("-", "").repeat(2), "i".repeat(64),
          "a".repeat(64), randomUUID(), "c".repeat(64), assurance,
        ],
      );
      return result.rows[0]!.session_id;
    }

    const ordinary = await issue("NONE");
    const assured = await issue("AMR_MFA");
    const sessions = await pool.query<{
      id: string;
      mfa_verified_at: Date | null;
      step_matches_expiry: boolean | null;
    }>(
      `SELECT id,mfa_verified_at,step_up_expires_at = expires_at AS step_matches_expiry
       FROM auth_sessions WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[ordinary, assured]],
    );
    const ordinaryRow = sessions.rows.find((row) => row.id === ordinary)!;
    const assuredRow = sessions.rows.find((row) => row.id === assured)!;
    expect(ordinaryRow.mfa_verified_at).toBeNull();
    expect(ordinaryRow.step_matches_expiry).toBeNull();
    expect(assuredRow.mfa_verified_at).toBeInstanceOf(Date);
    expect(assuredRow.step_matches_expiry).toBe(true);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM auth_security_events
       WHERE session_id=$1 AND event_type='OIDC_MFA_ASSURANCE_ACCEPTED'`,
      [assured],
    )).rows[0]?.count).toBe(1);
  });

  it("rejects assurance labels that the verified application cannot produce", async () => {
    await expect(pool.query(
      `SELECT app.auth_issue_oidc_user_session(
         $1,$2,$3,$4,$5,$6,$7,$8,'CLAIM_PRESENT'
       )`,
      [
        userId, organizationId, membershipId,
        randomUUID().replaceAll("-", "").repeat(2), "i".repeat(64),
        "a".repeat(64), randomUUID(), "c".repeat(64),
      ],
    )).rejects.toMatchObject({ code: "22023" });
  });
});
