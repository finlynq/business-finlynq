import { Pool, type QueryResult } from "pg";
import { existsSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { loadIdentitySecret } from "../../src/security/identity-secret";
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
import {
  verifyRestoredIdentityCiphertexts,
  type RestoredIdentityCiphertextRow,
} from "./restored-identity-secrets";
import {
  RESTORED_MASTER_DATA_FIELD_SPECIFICATIONS,
  restoredMasterDataCiphertextBatchQuery,
  verifyRestoredMasterDataCiphertexts,
  type RestoredMasterDataCiphertextRow,
} from "./restored-master-data-secrets";

const DECRYPTION_BATCH_SIZE = 1_000;

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

function writeKeyRecoveryEvidence(input: {
  status: "verified" | "verified-diagnostic";
  wrappedOrganizationKeys: number;
  encryptedOrganizationsMissingKeys: number;
  encryptedIdentities: number;
  syntheticDemoIdentities: number;
  encryptedPartyNames: number;
  encryptedPartyAddresses: number;
  encryptedBankingFields: number;
  diagnosticEscapeUsed: boolean;
  missingRepresentativeKinds: readonly string[];
}): void {
  const evidenceDirectory = process.env.RESTORE_EVIDENCE_DIR?.trim();
  if (!evidenceDirectory) return;
  const evidenceId = required("RESTORE_EVIDENCE_ID");
  const selectedSha256 = required("RESTORE_SELECTED_SHA256");
  const selectedArchive = required("RESTORE_SELECTED_ARCHIVE");
  if (!/^\d{8}T\d{6}Z_[a-f0-9]{12}$/.test(evidenceId)) {
    throw new Error("RESTORE_EVIDENCE_ID is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(selectedSha256)) {
    throw new Error("RESTORE_SELECTED_SHA256 is invalid");
  }
  if (!/^business_finlynq_[A-Za-z0-9_.-]+\.dump\.age$/.test(selectedArchive)) {
    throw new Error("RESTORE_SELECTED_ARCHIVE is invalid");
  }

  const resolvedDirectory = resolve(evidenceDirectory);
  if (!resolvedDirectory.startsWith("/backups/")) {
    throw new Error("Restore evidence directory must stay under the mounted backup path");
  }
  if (existsSync(resolvedDirectory)) {
    if (!lstatSync(resolvedDirectory).isDirectory() || lstatSync(resolvedDirectory).isSymbolicLink()) {
      throw new Error("Restore evidence directory must be a non-symbolic-link directory");
    }
  } else {
    const parent = dirname(resolvedDirectory);
    if (!existsSync(parent) || !lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) {
      throw new Error("Restore evidence parent directory is unavailable");
    }
    mkdirSync(resolvedDirectory, { mode: 0o700 });
  }

  const reportName = `key-recovery_${evidenceId}.json`;
  if (basename(reportName) !== reportName) throw new Error("Restore evidence report name is unsafe");
  const target = resolve(resolvedDirectory, reportName);
  const partial = resolve(resolvedDirectory, `.${reportName}.partial.${process.pid}`);
  if (existsSync(target)) throw new Error("Refusing to overwrite key-recovery evidence");
  const report = {
    schemaVersion: 1,
    product: "business-finlynq",
    result: input.status,
    verifiedAt: new Date().toISOString(),
    sha256: selectedSha256,
    encryptedArchive: selectedArchive,
    checks: {
      wrappedOrganizationKeys: input.wrappedOrganizationKeys > 0,
      encryptedKeyCoverage: input.encryptedOrganizationsMissingKeys === 0,
      encryptedIdentityDecryption: input.encryptedIdentities > 0,
      encryptedPartyDecryption: input.encryptedPartyNames > 0,
      encryptedAddressDecryption: input.encryptedPartyAddresses > 0,
      encryptedBankingDecryption: input.encryptedBankingFields > 0,
      diagnosticEscapeUsed: input.diagnosticEscapeUsed,
    },
    counts: {
      wrappedOrganizationKeys: input.wrappedOrganizationKeys,
      encryptedOrganizationsMissingKeys: input.encryptedOrganizationsMissingKeys,
      encryptedIdentities: input.encryptedIdentities,
      syntheticDemoIdentities: input.syntheticDemoIdentities,
      encryptedPartyNames: input.encryptedPartyNames,
      encryptedPartyAddresses: input.encryptedPartyAddresses,
      encryptedBankingFields: input.encryptedBankingFields,
    },
    diagnosticMissingRepresentatives: input.missingRepresentativeKinds,
  };
  try {
    writeFileSync(partial, `${JSON.stringify(report)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(partial, target);
  } catch (error) {
    if (existsSync(partial)) unlinkSync(partial);
    throw error;
  }
}

async function main(): Promise<void> {
  const requireWrappedKeys = enabled("RESTORE_REQUIRE_WRAPPED_KEYS");
  const allowEmptySecretFixtures = enabled("RESTORE_ALLOW_EMPTY_SECRET_FIXTURES");
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
      `WITH encrypted_key_reference AS (
         SELECT organization_id, display_name_key_version::int AS key_version
         FROM parties WHERE display_name_ciphertext IS NOT NULL
         UNION ALL
         SELECT organization_id,
           CASE WHEN key_version ~ '^[1-9][0-9]{0,8}$' THEN key_version::int END
         FROM party_addresses WHERE ciphertext IS NOT NULL
         UNION ALL
         SELECT organization_id, credentials_key_version::int
         FROM bank_connections WHERE credentials_ciphertext IS NOT NULL
         UNION ALL
         SELECT organization_id, key_version::int FROM bank_external_accounts
         WHERE provider_account_id_ciphertext IS NOT NULL OR display_name_ciphertext IS NOT NULL
         UNION ALL
         SELECT organization_id, key_version::int FROM bank_observations
         WHERE provider_transaction_id_ciphertext IS NOT NULL
         UNION ALL
         SELECT organization_id, key_version::int FROM bank_observation_versions
         WHERE details_ciphertext IS NOT NULL
         UNION ALL
         SELECT organization_id, key_version::int FROM bank_rules
         WHERE condition_ciphertext IS NOT NULL OR action_ciphertext IS NOT NULL
         UNION ALL
         SELECT organization_id, key_version::int FROM bank_draft_proposals
         WHERE payload_ciphertext IS NOT NULL
       )
       SELECT count(DISTINCT encrypted.organization_id)::int AS missing_count
       FROM encrypted_key_reference encrypted
       WHERE encrypted.key_version IS NULL OR NOT EXISTS (
         SELECT 1 FROM organization_key_versions key_version
         WHERE key_version.organization_id = encrypted.organization_id
           AND key_version.version = encrypted.key_version
       )`,
    );
    const encryptedOrganizationsMissingKeys = missingKeyCoverage.rows[0]?.missing_count ?? -1;
    if (encryptedOrganizationsMissingKeys !== 0) {
      throw new Error("Restore contains encrypted organization data without its exact wrapped key version");
    }

    const identityResult = await pool.query<RestoredIdentityCiphertextRow>(
      `SELECT id, email_ciphertext, display_name_ciphertext, is_demo
       FROM users ORDER BY id`,
    );
    const identityVerification = verifyRestoredIdentityCiphertexts(
      identityResult.rows,
      identitySecret,
    );

    const masterDataCounts = new Map<string, number>();
    for (const specification of RESTORED_MASTER_DATA_FIELD_SPECIFICATIONS) {
      let afterOrganizationId: string | null = null;
      let afterRecordId: string | null = null;
      let specificationCount = 0;
      while (true) {
        const masterDataResult: QueryResult<RestoredMasterDataCiphertextRow> =
          await pool.query<RestoredMasterDataCiphertextRow>(
            restoredMasterDataCiphertextBatchQuery(specification),
            [afterOrganizationId, afterRecordId, DECRYPTION_BATCH_SIZE],
          );
        specificationCount += verifyRestoredMasterDataCiphertexts(
          masterDataResult.rows,
          organizationDeks,
        );
        const lastRow = masterDataResult.rows.at(-1);
        if (!lastRow || masterDataResult.rows.length < DECRYPTION_BATCH_SIZE) break;
        afterOrganizationId = lastRow.organization_id;
        afterRecordId = lastRow.record_id;
      }
      masterDataCounts.set(`${specification.tableName}.${specification.columnName}`, specificationCount);
    }
    const decryptedPartyNameCount = masterDataCounts.get("parties.display_name_ciphertext") ?? 0;
    const decryptedPartyAddressCount = masterDataCounts.get("party_addresses.ciphertext") ?? 0;

    let decryptedBankingFieldCount = 0;
    for (const specification of RESTORED_BANKING_FIELD_SPECIFICATIONS) {
      let afterOrganizationId: string | null = null;
      let afterRecordId: string | null = null;
      while (true) {
        const bankingResult: QueryResult<RestoredBankingCiphertextRow> = await pool.query<RestoredBankingCiphertextRow>(
          restoredBankingCiphertextBatchQuery(specification),
          [afterOrganizationId, afterRecordId, DECRYPTION_BATCH_SIZE],
        );
        decryptedBankingFieldCount += verifyRestoredBankingCiphertexts(
          bankingResult.rows,
          organizationDeks,
        );
        const lastRow: RestoredBankingCiphertextRow | undefined = bankingResult.rows.at(-1);
        if (!lastRow || bankingResult.rows.length < DECRYPTION_BATCH_SIZE) break;
        afterOrganizationId = lastRow.organization_id;
        afterRecordId = lastRow.record_id;
      }
    }

    if (requireWrappedKeys && unwrappedKeyCount === 0) {
      throw new Error("Restore drill requires at least one recoverable organization key");
    }
    const missingRepresentativeKinds = [
      ["identity", identityVerification.encryptedIdentities],
      ["party-name", decryptedPartyNameCount],
      ["party-address", decryptedPartyAddressCount],
    ].filter(([, count]) => count === 0).map(([kind]) => kind as string);
    const diagnosticEscapeUsed = missingRepresentativeKinds.length > 0;
    if (diagnosticEscapeUsed && !allowEmptySecretFixtures) {
      throw new Error(
        `Restore drill has no representative encrypted ${missingRepresentativeKinds.join(", ")} row`,
      );
    }

    const verification = {
      status: diagnosticEscapeUsed ? "verified-diagnostic" as const : "verified" as const,
      wrappedOrganizationKeys: unwrappedKeyCount,
      encryptedOrganizationsMissingKeys,
      encryptedIdentities: identityVerification.encryptedIdentities,
      syntheticDemoIdentities: identityVerification.syntheticDemoIdentities,
      encryptedPartyNames: decryptedPartyNameCount,
      encryptedPartyAddresses: decryptedPartyAddressCount,
      encryptedBankingFields: decryptedBankingFieldCount,
      diagnosticEscapeUsed,
      missingRepresentativeKinds,
    };
    writeKeyRecoveryEvidence(verification);
    process.stdout.write(`${JSON.stringify(verification)}\n`);
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
