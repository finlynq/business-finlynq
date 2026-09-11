import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const runRuntime = databaseUrl && appDatabaseUrl ? describe : describe.skip;

const wrappedDek = JSON.stringify({
  format: "business-finlynq-wrapped-key-v1",
  provider: "test-provider",
  keyVersion: 1,
  iv: "a".repeat(16),
  ciphertext: "b".repeat(44),
  authTag: "c".repeat(24),
});

function fixture() {
  const organizationId = randomUUID();
  return {
    signupId: randomUUID(),
    userId: randomUUID(),
    organizationId,
    tokenId: randomUUID(),
    outboxId: randomUUID(),
    tokenHash: randomUUID().replaceAll("-", "").repeat(2),
    slug: `oidc-${organizationId.replaceAll("-", "").slice(0, 20)}`,
  };
}

async function beginOidcSignup(pool: Pool, selected: ReturnType<typeof fixture>, principalId: string) {
  return pool.query(
    `WITH begun AS MATERIALIZED (
       SELECT app.auth_begin_organization_signup(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25
       ) AS queued
     ), configured AS MATERIALIZED (
       SELECT app.auth_configure_organization_signup_oidc(
         $1,$22,$26,$27,$28,$29
       ) AS configured
       FROM begun WHERE begun.queued
     )
     SELECT begun.queued AND coalesce(configured.configured, false) AS queued
     FROM begun LEFT JOIN configured ON true`,
    [
      selected.signupId,
      selected.userId,
      selected.organizationId,
      selected.tokenId,
      randomUUID().replaceAll("-", "").repeat(2),
      `idv1:${"e".repeat(80)}`,
      `idv1:${"n".repeat(80)}`,
      selected.slug,
      "OIDC Integration Books",
      "CA01",
      "OIDC Integration Books Inc.",
      "CA",
      "ON",
      "CAD",
      "CAN_ASPE",
      2026,
      "AUTO_POST",
      "test-provider",
      wrappedDek,
      selected.tokenHash,
      `authv1:${"p".repeat(80)}`,
      selected.outboxId,
      "i".repeat(64),
      randomUUID(),
      "2026-08-27",
      "https://issuer.example.test/tenant/v2.0",
      "external-tenant",
      principalId,
      "c".repeat(64),
    ],
  );
}

run("PostgreSQL Microsoft owner signup", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => pool.end());

  it("cannot downgrade a Microsoft signup and activates without a local password", async () => {
    const selected = fixture();
    const principalId = `principal-${randomUUID()}`;
    expect((await beginOidcSignup(pool, selected, principalId)).rows[0]?.queued).toBe(true);
    expect((await pool.query(
      "SELECT template_data->>'authentication' AS authentication FROM auth_email_outbox WHERE id=$1",
      [selected.outboxId],
    )).rows[0]?.authentication).toBe("OIDC");

    const passwordHash = `scrypt-v1$32768$8$1$${"s".repeat(24)}$${"h".repeat(88)}`;
    expect((await pool.query(
      "SELECT * FROM app.auth_accept_local_organization_signup($1,$2,$3,$4,$5,$6)",
      [selected.tokenHash, passwordHash, randomUUID(), `authv1:${"f".repeat(80)}`,
        randomUUID().replaceAll("-", "").repeat(2), randomUUID()],
    )).rowCount).toBe(0);

    const factorId = randomUUID();
    const setupHash = randomUUID().replaceAll("-", "").repeat(2);
    expect((await pool.query(
      "SELECT * FROM app.auth_accept_oidc_organization_signup($1,$2,false,$3,$4,$5,$6,$7,$8,$9)",
      [selected.tokenHash, passwordHash, factorId, `authv1:${"f".repeat(80)}`,
        setupHash, randomUUID(), "https://issuer.example.test/tenant/v2.0",
        "external-tenant", "different-principal"],
    )).rowCount).toBe(0);
    const accepted = await pool.query(
      "SELECT * FROM app.auth_accept_oidc_organization_signup($1,$2,false,$3,$4,$5,$6,$7,$8,$9)",
      [selected.tokenHash, passwordHash, factorId, `authv1:${"f".repeat(80)}`,
        setupHash, randomUUID(), "https://issuer.example.test/tenant/v2.0",
        "external-tenant", principalId],
    );
    expect(accepted.rows[0]).toMatchObject({
      user_id: selected.userId,
      organization_name: "OIDC Integration Books",
      factor_id: factorId,
    });
    expect((await pool.query(
      "SELECT password_hash,password_changed_at FROM users WHERE id=$1",
      [selected.userId],
    )).rows[0]).toEqual({ password_hash: "!oidc-only!", password_changed_at: null });
    expect((await pool.query(
      "SELECT * FROM app.auth_resolve_oidc_identity($1,$2,$3)",
      ["https://issuer.example.test/tenant/v2.0", "external-tenant", principalId],
    )).rowCount).toBe(0);

    expect((await pool.query(
      "SELECT app.auth_finish_mfa_enrollment($1,$2,1,$3) AS finished",
      [setupHash, factorId, randomUUID()],
    )).rows[0]?.finished).toBe(true);
    expect((await pool.query(
      "SELECT * FROM app.auth_resolve_oidc_identity($1,$2,$3)",
      ["https://issuer.example.test/tenant/v2.0", "external-tenant", principalId],
    )).rows[0]).toMatchObject({
      user_id: selected.userId,
      organization_id: selected.organizationId,
    });
  });

  it("retains an independent Business password only when dual mode is selected", async () => {
    const selected = fixture();
    const principalId = `principal-${randomUUID()}`;
    expect((await beginOidcSignup(pool, selected, principalId)).rows[0]?.queued).toBe(true);
    const passwordHash = `scrypt-v1$32768$8$1$${"d".repeat(24)}$${"p".repeat(88)}`;
    expect((await pool.query(
      "SELECT * FROM app.auth_accept_oidc_organization_signup($1,$2,true,$3,$4,$5,$6,$7,$8,$9)",
      [selected.tokenHash, passwordHash, randomUUID(), `authv1:${"f".repeat(80)}`,
        randomUUID().replaceAll("-", "").repeat(2), randomUUID(),
        "https://issuer.example.test/tenant/v2.0", "external-tenant", principalId],
    )).rowCount).toBe(1);
    expect((await pool.query(
      "SELECT password_hash,password_changed_at IS NOT NULL AS changed FROM users WHERE id=$1",
      [selected.userId],
    )).rows[0]).toEqual({ password_hash: passwordHash, changed: true });
  });
});

runRuntime("PostgreSQL Microsoft signup runtime boundary", () => {
  const pool = new Pool({ connectionString: appDatabaseUrl });
  afterAll(async () => pool.end());

  it("exposes the exact identity functions without direct identity-table access", async () => {
    await expect(pool.query(
      "SELECT * FROM app.auth_resolve_oidc_identity($1,$2,$3)",
      ["https://issuer.example.test/tenant/v2.0", "external-tenant", "unassigned-principal"],
    )).resolves.toBeTruthy();
    await expect(pool.query(
      "SELECT * FROM app.auth_accept_local_organization_signup($1,$2,$3,$4,$5,$6)",
      ["x".repeat(64), `scrypt-v1$32768$8$1$${"s".repeat(24)}$${"h".repeat(88)}`,
        randomUUID(), `authv1:${"f".repeat(80)}`, "s".repeat(64), randomUUID()],
    )).resolves.toBeTruthy();
    await expect(pool.query(
      "SELECT issuer,external_principal_id,user_id FROM auth_oidc_identities LIMIT 1",
    )).rejects.toThrow(/permission denied/);
    await expect(pool.query(
      "SELECT oidc_issuer FROM auth_organization_signups LIMIT 1",
    )).rejects.toThrow(/permission denied/);
  });
});
