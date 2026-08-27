import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;
const migration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0015_signup_compatibility_forward.sql"),
  "utf8",
);
const backfillStart = migration.indexOf("-- BEGIN SIGNUP COMPATIBILITY COLUMN BACKFILL");
const backfillEnd = migration.indexOf("-- END SIGNUP COMPATIBILITY COLUMN BACKFILL");
const backfillSql = migration
  .slice(backfillStart, backfillEnd)
  .replaceAll("--> statement-breakpoint", "");
const rerunnableMigrationSql = migration.replaceAll("--> statement-breakpoint", "");

runDatabaseTests("forward-only signup compatibility migration", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  afterAll(async () => pool.end());

  it("backfills an original-0013 row, restores NOT NULL, and reruns safely", async () => {
    expect(backfillStart).toBeGreaterThanOrEqual(0);
    expect(backfillEnd).toBeGreaterThan(backfillStart);
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const userId = randomUUID();
      const tokenId = randomUUID();
      const signupId = randomUUID();
      const organizationId = randomUUID();
      const emailCiphertext = `idv1:${"e".repeat(80)}`;
      const displayNameCiphertext = `idv1:${"n".repeat(80)}`;

      await client.query(
        `ALTER TABLE auth_organization_signups
           ADD COLUMN IF NOT EXISTS identity_encryption_user_id uuid,
           ADD COLUMN IF NOT EXISTS requested_email_ciphertext text,
           ADD COLUMN IF NOT EXISTS requested_display_name_ciphertext text,
           ALTER COLUMN identity_encryption_user_id DROP NOT NULL,
           ALTER COLUMN requested_email_ciphertext DROP NOT NULL,
           ALTER COLUMN requested_display_name_ciphertext DROP NOT NULL`,
      );
      await client.query(
        `INSERT INTO users(
           id,email_lookup_hash,email_ciphertext,display_name_ciphertext,
           password_hash,active,is_demo,mfa_required
         ) VALUES($1,$2,$3,$4,'!organization-signup-pending!',false,false,true)`,
        [
          userId,
          randomUUID().replaceAll("-", "").repeat(2),
          emailCiphertext,
          displayNameCiphertext,
        ],
      );
      await client.query(
        `INSERT INTO auth_one_time_tokens(
           id,token_hash,purpose,user_id,expires_at
         ) VALUES($1,$2,'ORGANIZATION_SIGNUP',$3,now()+interval '1 day')`,
        [tokenId, randomUUID().replaceAll("-", "").repeat(2), userId],
      );
      await client.query(
        `INSERT INTO auth_organization_signups(
           id,token_id,user_id,organization_id,organization_slug,
           organization_name,entity_code,entity_name,country_code,region_code,
           functional_currency,accounting_profile,fiscal_year,
           manual_posting_mode,key_provider,wrapped_dek,terms_version,
           status,expires_at
         ) VALUES(
           $1,$2,$3,$4,$5,'Compatibility business','COMPAT','Compatibility entity',
           'CA','ON','CAD','CAN_ASPE',2026,'REVIEW_REQUIRED',
           'local-test',$6,'terms-v1','PENDING',now()+interval '1 day'
         )`,
        [
          signupId,
          tokenId,
          userId,
          organizationId,
          `compat-${organizationId.replaceAll("-", "").slice(0, 20)}`,
          `wrapped:${"w".repeat(80)}`,
        ],
      );

      await client.query(backfillSql);
      expect((await client.query(
        `SELECT identity_encryption_user_id,requested_email_ciphertext,
           requested_display_name_ciphertext
         FROM auth_organization_signups WHERE id=$1`,
        [signupId],
      )).rows[0]).toEqual({
        identity_encryption_user_id: userId,
        requested_email_ciphertext: emailCiphertext,
        requested_display_name_ciphertext: displayNameCiphertext,
      });
      expect((await client.query<{ attname: string; attnotnull: boolean }>(
        `SELECT attribute.attname,attribute.attnotnull
         FROM pg_attribute attribute
         WHERE attribute.attrelid='auth_organization_signups'::regclass
           AND attribute.attname IN (
             'identity_encryption_user_id',
             'requested_email_ciphertext',
             'requested_display_name_ciphertext'
           )
         ORDER BY attribute.attname`,
      )).rows).toEqual([
        { attname: "identity_encryption_user_id", attnotnull: true },
        { attname: "requested_display_name_ciphertext", attnotnull: true },
        { attname: "requested_email_ciphertext", attnotnull: true },
      ]);

      await client.query(rerunnableMigrationSql);
      const definitions = await client.query<{ name: string; definition: string }>(
        `SELECT procedure.proname AS name,pg_get_functiondef(procedure.oid) AS definition
         FROM pg_proc procedure
         JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
         WHERE namespace.nspname='app'
           AND procedure.proname IN (
             'auth_begin_organization_signup',
             'auth_accept_organization_signup',
             'auth_finish_mfa_enrollment'
           )`,
      );
      expect(definitions.rows).toHaveLength(3);
      for (const row of definitions.rows) {
        expect(row.definition).toContain("SECURITY DEFINER");
        expect(row.definition).toContain("SET search_path TO 'public', 'pg_temp'");
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
