import {
  decryptField,
  parseEncryptedField,
} from "../../src/security/organization-encryption";
import { restoredOrganizationKeyMapKey } from "./restored-banking-secrets";

type MasterDataPlaintextKind = "display-name" | "address-json";

export type RestoredMasterDataFieldSpecification = Readonly<{
  tableName: "parties" | "party_addresses";
  columnName: "display_name_ciphertext" | "ciphertext";
  keyVersionColumn: "display_name_key_version" | "key_version";
  plaintextKind: MasterDataPlaintextKind;
}>;

export const RESTORED_MASTER_DATA_FIELD_SPECIFICATIONS: readonly RestoredMasterDataFieldSpecification[] = [
  {
    tableName: "parties",
    columnName: "display_name_ciphertext",
    keyVersionColumn: "display_name_key_version",
    plaintextKind: "display-name",
  },
  {
    tableName: "party_addresses",
    columnName: "ciphertext",
    keyVersionColumn: "key_version",
    plaintextKind: "address-json",
  },
] as const;

const specificationByField = new Map(
  RESTORED_MASTER_DATA_FIELD_SPECIFICATIONS.map((specification) => [
    `${specification.tableName}.${specification.columnName}`,
    specification,
  ]),
);

export type RestoredMasterDataCiphertextRow = Readonly<{
  organization_id: string;
  record_id: string;
  key_version: number;
  table_name: string;
  column_name: string;
  ciphertext: string;
}>;

export function restoredMasterDataCiphertextBatchQuery(
  specification: RestoredMasterDataFieldSpecification,
): string {
  if (specificationByField.get(`${specification.tableName}.${specification.columnName}`) !== specification) {
    throw new Error("Restore verifier received an unsupported master-data field specification");
  }
  return `SELECT organization_id, id::text AS record_id,
    ${specification.keyVersionColumn}::int AS key_version,
    '${specification.tableName}'::text AS table_name,
    '${specification.columnName}'::text AS column_name,
    ${specification.columnName} AS ciphertext
  FROM ${specification.tableName}
  WHERE ${specification.columnName} IS NOT NULL
    AND ($1::uuid IS NULL OR (organization_id, id) > ($1::uuid, $2::uuid))
  ORDER BY organization_id, id
  LIMIT $3`;
}

function assertMasterDataPlaintext(kind: MasterDataPlaintextKind, value: string): void {
  if (!value || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error("Decrypted master-data text is empty or contains control characters");
  }
  if (kind !== "address-json") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Decrypted party address is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Decrypted party address is not a JSON object");
  }
}

export function verifyRestoredMasterDataCiphertexts(
  rows: readonly RestoredMasterDataCiphertextRow[],
  organizationDeks: ReadonlyMap<string, Buffer>,
): number {
  let verifiedCount = 0;
  for (const row of rows) {
    const specification = specificationByField.get(`${row.table_name}.${row.column_name}`);
    if (!specification) {
      throw new Error("Restore verifier received an unsupported master-data ciphertext field");
    }
    if (!Number.isSafeInteger(row.key_version) || row.key_version <= 0) {
      throw new Error("Restore contains master-data ciphertext with an invalid key version");
    }
    const organizationDek = organizationDeks.get(
      restoredOrganizationKeyMapKey(row.organization_id, row.key_version),
    );
    if (!organizationDek) {
      throw new Error("Restore contains master-data ciphertext without its exact organization key version");
    }
    const plaintext = decryptField(parseEncryptedField(row.ciphertext), organizationDek, {
      organizationId: row.organization_id,
      table: specification.tableName,
      column: specification.columnName,
      recordId: row.record_id,
      keyVersion: row.key_version,
    });
    assertMasterDataPlaintext(specification.plaintextKind, plaintext);
    verifiedCount += 1;
  }
  return verifiedCount;
}
