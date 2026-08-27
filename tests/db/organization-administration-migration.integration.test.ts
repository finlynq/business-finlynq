import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;
const migration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0014_organization_member_administration.sql"),
  "utf8",
);
const backfillStart = migration.indexOf("WITH legacy_invitation AS (");
const backfillEnd = migration.indexOf(
  "-- Register the organization-owned invitation table",
  backfillStart,
);
const legacyBackfillSql = migration
  .slice(backfillStart, backfillEnd)
  .replaceAll("--> statement-breakpoint", "");

runDatabaseTests("organization invitation migration backfill", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  afterAll(async () => pool.end());

  it("retains outstanding and interrupted-MFA invitations and accepts completed history", async () => {
    expect(backfillStart).toBeGreaterThan(0);
    expect(backfillEnd).toBeGreaterThan(backfillStart);
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const organizationId = randomUUID();
      const roleId = randomUUID();
      await client.query(
        `INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode)
         VALUES($1,$2,'Legacy invitation migration',true,false,'REAL')`,
        [organizationId, `legacy-invite-${organizationId.slice(0, 8)}`],
      );
      await client.query(
        `INSERT INTO roles(id,organization_id,key,display_name,system_template,active)
         VALUES($1,$2,'VIEWER_AUDITOR','Viewer / auditor',true,true)`,
        [roleId, organizationId],
      );

      const cases = [
        { userActive: false, membershipActive: false, interrupted: false, enrolled: false, expected: "PENDING" },
        { userActive: false, membershipActive: false, interrupted: true, enrolled: false, expected: "PENDING" },
        { userActive: true, membershipActive: true, interrupted: false, enrolled: false, expected: "ACCEPTED" },
        { userActive: true, membershipActive: false, interrupted: false, enrolled: true, expected: "ACCEPTED" },
      ] as const;
      const seeded: Array<{ userId: string; membershipId: string; tokenId: string; expected: string }> = [];
      for (const item of cases) {
        const userId = randomUUID();
        const membershipId = randomUUID();
        const tokenId = randomUUID();
        const emailHash = randomUUID().replaceAll("-", "").repeat(2);
        await client.query(
          `INSERT INTO users(
             id,email_lookup_hash,email_ciphertext,display_name_ciphertext,
             password_hash,active,is_demo,mfa_required,email_verified_at
           ) VALUES($1,$2,$3,$4,$5,$6,false,true,$7)`,
          [
            userId,
            emailHash,
            `idv1:${"e".repeat(80)}`,
            `idv1:${"n".repeat(80)}`,
            item.interrupted
              ? `scrypt-v1$32768$8$1$${"s".repeat(24)}$${"h".repeat(88)}`
              : "!invitation-pending!",
            item.userActive,
            item.interrupted || item.userActive ? new Date() : null,
          ],
        );
        await client.query(
          `INSERT INTO organization_memberships(id,organization_id,user_id,active)
           VALUES($1,$2,$3,$4)`,
          [membershipId, organizationId, userId, item.membershipActive],
        );
        await client.query(
          `INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by)
           VALUES($1,$2,$3,$4)`,
          [organizationId, membershipId, roleId, userId],
        );
        await client.query(
          `INSERT INTO auth_one_time_tokens(
             id,token_hash,purpose,user_id,organization_id,created_at,expires_at,consumed_at
           ) VALUES($1,$2,'INVITATION',$3,$4,
             now()-interval '1 hour',now()+interval '71 hours',$5)`,
          [
            tokenId,
            randomUUID().replaceAll("-", "").repeat(2),
            userId,
            organizationId,
            item.interrupted || item.userActive ? new Date() : null,
          ],
        );
        if (item.interrupted || item.enrolled) {
          await client.query(
            `INSERT INTO auth_mfa_factors(
               id,user_id,factor_type,label,secret_ciphertext,status
             ) VALUES($1,$2,'TOTP','Primary authenticator',$3,$4)`,
            [
              randomUUID(),
              userId,
              `authv1:${"f".repeat(80)}`,
              item.enrolled ? "ACTIVE" : "PENDING",
            ],
          );
          if (item.enrolled) {
            await client.query(
              `UPDATE auth_mfa_factors SET verified_at=now()
               WHERE user_id=$1 AND status='ACTIVE'`,
              [userId],
            );
          }
        }
        seeded.push({ userId, membershipId, tokenId, expected: item.expected });
      }

      await client.query(legacyBackfillSql);
      for (const item of seeded) {
        expect((await client.query(
          `SELECT status,token_id,accepted_at,created_at,expires_at
           FROM organization_invitations
           WHERE organization_id=$1 AND membership_id=$2 AND user_id=$3`,
          [organizationId, item.membershipId, item.userId],
        )).rows[0]).toMatchObject({
          status: item.expected,
          token_id: item.tokenId,
          accepted_at: item.expected === "ACCEPTED" ? expect.any(Date) : null,
          created_at: expect.any(Date),
          expires_at: expect.any(Date),
        });
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
