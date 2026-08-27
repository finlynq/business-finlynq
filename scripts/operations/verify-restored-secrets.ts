import { Pool } from "pg";
import { decryptIdentityField, loadIdentitySecret } from "../../src/security/identity-secret";
import {
  LocalRootKeyProvider,
  parseWrappedKey,
} from "../../src/security/organization-encryption";
import { loadOrganizationRootKek } from "../../src/security/root-secret";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for restore verification`);
  return value;
}

function enabled(name: string): boolean {
  const value = process.env[name] ?? "false";
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}

async function main(): Promise<void> {
  const pool = new Pool({
    host: required("BUSINESS_FINLYNQ_DB_HOST"),
    port: Number(process.env.BUSINESS_FINLYNQ_DB_PORT ?? "5432"),
    database: required("BUSINESS_FINLYNQ_DB_NAME"),
    user: required("BUSINESS_FINLYNQ_DB_USER"),
    password: required("BUSINESS_FINLYNQ_DB_PASSWORD"),
    max: 1,
    connectionTimeoutMillis: 5_000,
    application_name: "business-finlynq-restore-verifier",
  });

  const rootKey = loadOrganizationRootKek();
  const identitySecret = loadIdentitySecret();
  const keyProvider = new LocalRootKeyProvider(rootKey);

  try {
    const keyResult = await pool.query<{
      organization_id: string;
      wrapped_dek: string;
    }>(
      "SELECT organization_id, wrapped_dek FROM organization_key_versions ORDER BY organization_id, version",
    );

    let unwrappedKeyCount = 0;
    for (const row of keyResult.rows) {
      const organizationDek = keyProvider.unwrapOrganizationKey(
        row.organization_id,
        parseWrappedKey(row.wrapped_dek),
      );
      organizationDek.fill(0);
      unwrappedKeyCount += 1;
    }

    const missingKeyCoverage = await pool.query<{ missing_count: number }>(
      `SELECT count(*)::int AS missing_count
       FROM (
         SELECT organization_id FROM parties WHERE display_name_ciphertext IS NOT NULL
         UNION
         SELECT organization_id FROM party_addresses WHERE ciphertext IS NOT NULL
       ) encrypted_organization
       WHERE NOT EXISTS (
         SELECT 1 FROM organization_key_versions key_version
         WHERE key_version.organization_id = encrypted_organization.organization_id
           AND key_version.active
       )`,
    );
    const encryptedOrganizationsMissingKeys = missingKeyCoverage.rows[0]?.missing_count ?? -1;
    if (encryptedOrganizationsMissingKeys !== 0) {
      throw new Error("Restore contains encrypted organization data without an active wrapped key");
    }

    const identityResult = await pool.query<{
      id: string;
      email_ciphertext: string;
      display_name_ciphertext: string | null;
    }>(
      "SELECT id, email_ciphertext, display_name_ciphertext FROM users WHERE email_ciphertext LIKE 'idv1:%' ORDER BY id",
    );

    let decryptedIdentityCount = 0;
    for (const row of identityResult.rows) {
      decryptIdentityField(row.email_ciphertext, "email", row.id, identitySecret);
      if (row.display_name_ciphertext) {
        decryptIdentityField(row.display_name_ciphertext, "display-name", row.id, identitySecret);
      }
      decryptedIdentityCount += 1;
    }

    if (enabled("RESTORE_REQUIRE_WRAPPED_KEYS") && unwrappedKeyCount === 0) {
      throw new Error("Restore drill requires at least one recoverable organization key");
    }
    if (enabled("RESTORE_REQUIRE_ENCRYPTED_IDENTITIES") && decryptedIdentityCount === 0) {
      throw new Error("Restore drill requires at least one decryptable real-user identity");
    }

    process.stdout.write(`${JSON.stringify({
      status: "verified",
      wrappedOrganizationKeys: unwrappedKeyCount,
      encryptedOrganizationsMissingKeys,
      encryptedIdentities: decryptedIdentityCount,
    })}\n`);
  } finally {
    rootKey.fill(0);
    identitySecret.fill(0);
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Restore secret verification failed", {
    error: error instanceof Error ? error.message : "unknown error",
  });
  process.exitCode = 1;
});
