import {
  decryptField,
  parseEncryptedField,
} from "../../src/security/organization-encryption";

type BankingPlaintextKind = "access-url" | "opaque-id" | "display-name" | "json-object";

export type RestoredBankingFieldSpecification = Readonly<{
  tableName: string;
  columnName: string;
  keyVersionColumn: string;
  plaintextKind: BankingPlaintextKind;
}>;

export const RESTORED_BANKING_FIELD_SPECIFICATIONS: readonly RestoredBankingFieldSpecification[] = [
  {
    tableName: "bank_connections",
    columnName: "credentials_ciphertext",
    keyVersionColumn: "credentials_key_version",
    plaintextKind: "access-url",
  },
  {
    tableName: "bank_external_accounts",
    columnName: "provider_account_id_ciphertext",
    keyVersionColumn: "key_version",
    plaintextKind: "opaque-id",
  },
  {
    tableName: "bank_external_accounts",
    columnName: "display_name_ciphertext",
    keyVersionColumn: "key_version",
    plaintextKind: "display-name",
  },
  {
    tableName: "bank_observations",
    columnName: "provider_transaction_id_ciphertext",
    keyVersionColumn: "key_version",
    plaintextKind: "opaque-id",
  },
  {
    tableName: "bank_observation_versions",
    columnName: "details_ciphertext",
    keyVersionColumn: "key_version",
    plaintextKind: "json-object",
  },
  {
    tableName: "bank_rules",
    columnName: "condition_ciphertext",
    keyVersionColumn: "key_version",
    plaintextKind: "json-object",
  },
  {
    tableName: "bank_rules",
    columnName: "action_ciphertext",
    keyVersionColumn: "key_version",
    plaintextKind: "json-object",
  },
  {
    tableName: "bank_draft_proposals",
    columnName: "payload_ciphertext",
    keyVersionColumn: "key_version",
    plaintextKind: "json-object",
  },
] as const;

const specificationByField = new Map(
  RESTORED_BANKING_FIELD_SPECIFICATIONS.map((specification) => [
    `${specification.tableName}.${specification.columnName}`,
    specification,
  ]),
);

export type RestoredBankingCiphertextRow = Readonly<{
  organization_id: string;
  record_id: string;
  key_version: number;
  table_name: string;
  column_name: string;
  ciphertext: string;
}>;

export function restoredBankingCiphertextBatchQuery(
  specification: RestoredBankingFieldSpecification,
): string {
  if (specificationByField.get(`${specification.tableName}.${specification.columnName}`) !== specification) {
    throw new Error("Restore verifier received an unsupported banking field specification");
  }
  return `SELECT organization_id, id::text AS record_id,
    ${specification.keyVersionColumn}::int AS key_version,
    '${specification.tableName}'::text AS table_name,
    '${specification.columnName}'::text AS column_name,
    ${specification.columnName} AS ciphertext
  FROM ${specification.tableName}
  WHERE ($1::uuid IS NULL OR (organization_id, id) > ($1::uuid, $2::uuid))
  ORDER BY organization_id, id
  LIMIT $3`;
}

export function restoredOrganizationKeyMapKey(organizationId: string, keyVersion: number): string {
  return `${organizationId}:${keyVersion}`;
}

function assertJsonObject(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Decrypted banking JSON is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Decrypted banking JSON is not an object");
  }
}

function assertPlaintext(kind: BankingPlaintextKind, value: string): void {
  if (!value || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error("Decrypted banking text is empty or contains control characters");
  }
  if (kind === "json-object") {
    assertJsonObject(value);
    return;
  }
  if (kind === "access-url") {
    try {
      const accessUrl = new URL(value);
      if (accessUrl.protocol !== "https:" || !accessUrl.username || !accessUrl.password) {
        throw new Error("invalid access URL");
      }
      return;
    } catch {
      // The public demo deliberately stores a non-routable encrypted marker in
      // its disabled synthetic connection instead of a provider credential.
    }
    try {
      const synthetic = JSON.parse(value) as Record<string, unknown>;
      if (synthetic.synthetic === true && synthetic.outboundProviderCallsAllowed === false) return;
    } catch {
      // Report one sanitized credential-format failure below.
    }
    throw new Error("Decrypted bank credential is neither a valid HTTPS access URL nor a disabled demo marker");
  }
}

export function verifyRestoredBankingCiphertexts(
  rows: readonly RestoredBankingCiphertextRow[],
  organizationDeks: ReadonlyMap<string, Buffer>,
): number {
  let verifiedCount = 0;
  for (const row of rows) {
    const specification = specificationByField.get(`${row.table_name}.${row.column_name}`);
    if (!specification) {
      throw new Error("Restore verifier received an unsupported banking ciphertext field");
    }
    if (!Number.isSafeInteger(row.key_version) || row.key_version <= 0) {
      throw new Error("Restore contains a banking ciphertext with an invalid key version");
    }
    const organizationDek = organizationDeks.get(
      restoredOrganizationKeyMapKey(row.organization_id, row.key_version),
    );
    if (!organizationDek) {
      throw new Error("Restore contains banking ciphertext without its exact organization key version");
    }
    const plaintext = decryptField(parseEncryptedField(row.ciphertext), organizationDek, {
      organizationId: row.organization_id,
      table: specification.tableName,
      column: specification.columnName,
      recordId: row.record_id,
      keyVersion: row.key_version,
    });
    assertPlaintext(specification.plaintextKind, plaintext);
    verifiedCount += 1;
  }
  return verifiedCount;
}
