import { Pool, type QueryResult } from "pg";
import { decryptIdentityField, loadIdentitySecret } from "../../src/security/identity-secret";
import {
  LocalRootKeyProvider,
  parseWrappedKey,
} from "../../src/security/organization-encryption";
import { loadOrganizationRootKek } from "../../src/security/root-secret";
import {
  RESTORED_BANKING_FIELD_SPECIFICATIONS,
  restoredBankingCiphertextBatchQuery,
  restoredOrganizationKeyMapKey,
  type RestoredBankingCiphertextRow,
  verifyRestoredBankingCiphertexts,
} from "./restored-banking-secrets";

const BANKING_DECRYPTION_BATCH_SIZE = 1_000;

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
  const organizationDeks = new Map<string, Buffer>();

  try {
    const keyResult = await pool.query<{
      organization_id: string;
      version: number;
      key_provider: string;
      wrapped_dek: string;
    }>(
      `SELECT organization_id, version, key_provider, wrapped_dek
       FROM organization_key_versions ORDER BY organization_id, version`,
    );

    let unwrappedKeyCount = 0;
    for (const row of keyResult.rows) {
      if (!Number.isSafeInteger(row.version) || row.version <= 0) {
        throw new Error("Organization key metadata contains an invalid version");
      }
      const wrapped = parseWrappedKey(row.wrapped_dek);
      if (wrapped.provider !== row.key_provider || wrapped.keyVersion !== row.version) {
        throw new Error("Organization key envelope does not match its restored database metadata");
      }
      const mapKey = restoredOrganizationKeyMapKey(row.organization_id, row.version);
      if (organizationDeks.has(mapKey)) {
        throw new Error("Restore contains duplicate organization key metadata");
      }
      const organizationDek = keyProvider.unwrapOrganizationKey(row.organization_id, wrapped);
      organizationDeks.set(mapKey, organizationDek);
      unwrappedKeyCount += 1;
    }

    const missingKeyCoverage = await pool.query<{ missing_count: number }>(
      `SELECT count(*)::int AS missing_count
       FROM (
          SELECT organization_id FROM parties WHERE display_name_ciphertext IS NOT NULL
          UNION
          SELECT organization_id FROM party_addresses WHERE ciphertext IS NOT NULL
          UNION
          SELECT organization_id FROM bank_connections WHERE credentials_ciphertext IS NOT NULL
          UNION
          SELECT organization_id FROM bank_external_accounts
            WHERE provider_account_id_ciphertext IS NOT NULL OR display_name_ciphertext IS NOT NULL
          UNION
          SELECT organization_id FROM bank_observations WHERE provider_transaction_id_ciphertext IS NOT NULL
          UNION
          SELECT organization_id FROM bank_observation_versions WHERE details_ciphertext IS NOT NULL
          UNION
          SELECT organization_id FROM bank_rules
            WHERE condition_ciphertext IS NOT NULL OR action_ciphertext IS NOT NULL
          UNION
          SELECT organization_id FROM bank_draft_proposals WHERE payload_ciphertext IS NOT NULL
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

    let decryptedBankingFieldCount = 0;
    for (const specification of RESTORED_BANKING_FIELD_SPECIFICATIONS) {
      let afterOrganizationId: string | null = null;
      let afterRecordId: string | null = null;
      while (true) {
        const bankingResult: QueryResult<RestoredBankingCiphertextRow> = await pool.query<RestoredBankingCiphertextRow>(
          restoredBankingCiphertextBatchQuery(specification),
          [afterOrganizationId, afterRecordId, BANKING_DECRYPTION_BATCH_SIZE],
        );
        decryptedBankingFieldCount += verifyRestoredBankingCiphertexts(
          bankingResult.rows,
          organizationDeks,
        );
        const lastRow: RestoredBankingCiphertextRow | undefined = bankingResult.rows.at(-1);
        if (!lastRow || bankingResult.rows.length < BANKING_DECRYPTION_BATCH_SIZE) break;
        afterOrganizationId = lastRow.organization_id;
        afterRecordId = lastRow.record_id;
      }
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
      encryptedBankingFields: decryptedBankingFieldCount,
    })}\n`);
  } finally {
    for (const organizationDek of organizationDeks.values()) organizationDek.fill(0);
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
