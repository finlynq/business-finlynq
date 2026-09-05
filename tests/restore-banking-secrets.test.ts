import { describe, expect, it } from "vitest";
import {
  encryptField,
  generateOrganizationDek,
  serializeEncryptedField,
} from "@/security/organization-encryption";
import {
  RESTORED_BANKING_FIELD_SPECIFICATIONS,
  restoredBankingCiphertextBatchQuery,
  restoredOrganizationKeyMapKey,
  type RestoredBankingCiphertextRow,
  verifyRestoredBankingCiphertexts,
} from "../scripts/operations/restored-banking-secrets";

const organizationId = "10000000-0000-4000-8000-000000000001";
const recordId = "20000000-0000-4000-8000-000000000001";
const keyVersion = 3;

function plaintextFor(kind: string): string {
  if (kind === "bank-credential") return "https://simplefin-user:simplefin-pass@example.com/simplefin";
  if (kind === "json-object") return JSON.stringify({ verified: true });
  return "restored-provider-value";
}

function encryptedRow(
  dek: Buffer,
  specification: (typeof RESTORED_BANKING_FIELD_SPECIFICATIONS)[number],
  overrides: Partial<RestoredBankingCiphertextRow> = {},
): RestoredBankingCiphertextRow {
  const ciphertext = serializeEncryptedField(encryptField(
    plaintextFor(specification.plaintextKind),
    dek,
    {
      organizationId,
      table: specification.tableName,
      column: specification.columnName,
      recordId,
      keyVersion,
    },
  ));
  return {
    organization_id: organizationId,
    record_id: recordId,
    key_version: keyVersion,
    table_name: specification.tableName,
    column_name: specification.columnName,
    ciphertext,
    provider: specification.tableName === "bank_connections" ? "SIMPLEFIN" : null,
    ...overrides,
  };
}

describe("restored banking secret verification", () => {
  it("queries and authenticates every encrypted banking field with its exact AAD", () => {
    const dek = generateOrganizationDek();
    try {
      const rows = RESTORED_BANKING_FIELD_SPECIFICATIONS.map((specification) => encryptedRow(dek, specification));
      const deks = new Map([[restoredOrganizationKeyMapKey(organizationId, keyVersion), dek]]);

      expect(verifyRestoredBankingCiphertexts(rows, deks)).toBe(RESTORED_BANKING_FIELD_SPECIFICATIONS.length);
      for (const specification of RESTORED_BANKING_FIELD_SPECIFICATIONS) {
        const query = restoredBankingCiphertextBatchQuery(specification);
        expect(query).toContain(`FROM ${specification.tableName}`);
        expect(query).toContain(`${specification.columnName} AS ciphertext`);
        expect(query).toContain(
          `${specification.tableName === "bank_connections" ? "provider" : "NULL::text"} AS provider`,
        );
        expect(query).toContain("ORDER BY organization_id, id");
        expect(query).toContain("LIMIT $3");
      }
    } finally {
      dek.fill(0);
    }
  });

  it("fails when a restored row does not have its exact organization key version", () => {
    const dek = generateOrganizationDek();
    try {
      const row = encryptedRow(dek, RESTORED_BANKING_FIELD_SPECIFICATIONS[0]!);
      expect(() => verifyRestoredBankingCiphertexts([row], new Map())).toThrow(
        "without its exact organization key version",
      );
    } finally {
      dek.fill(0);
    }
  });

  it("fails closed when banking ciphertext is moved to another AAD context", () => {
    const dek = generateOrganizationDek();
    try {
      const row = encryptedRow(dek, RESTORED_BANKING_FIELD_SPECIFICATIONS[1]!, {
        record_id: "20000000-0000-4000-8000-000000000002",
      });
      const deks = new Map([[restoredOrganizationKeyMapKey(organizationId, keyVersion), dek]]);
      expect(() => verifyRestoredBankingCiphertexts([row], deks)).toThrow();
    } finally {
      dek.fill(0);
    }
  });

  it("fails closed when database and ciphertext key versions disagree", () => {
    const dek = generateOrganizationDek();
    try {
      const row = encryptedRow(dek, RESTORED_BANKING_FIELD_SPECIFICATIONS[0]!, {
        key_version: keyVersion + 1,
      });
      const deks = new Map([[restoredOrganizationKeyMapKey(organizationId, keyVersion + 1), dek]]);
      expect(() => verifyRestoredBankingCiphertexts([row], deks)).toThrow(
        "metadata does not match",
      );
    } finally {
      dek.fill(0);
    }
  });

  it("accepts the exact encrypted FILE_IMPORT marker without parsing it as a SimpleFIN URL", () => {
    const dek = generateOrganizationDek();
    try {
      const specification = RESTORED_BANKING_FIELD_SPECIFICATIONS[0]!;
      expect(specification.plaintextKind).toBe("bank-credential");
      const ciphertext = serializeEncryptedField(encryptField("document-inbox-local-v1", dek, {
        organizationId,
        table: specification.tableName,
        column: specification.columnName,
        recordId,
        keyVersion,
      }));
      const row: RestoredBankingCiphertextRow = {
        organization_id: organizationId,
        record_id: recordId,
        key_version: keyVersion,
        table_name: specification.tableName,
        column_name: specification.columnName,
        ciphertext,
        provider: "FILE_IMPORT",
      };
      const deks = new Map([[restoredOrganizationKeyMapKey(organizationId, keyVersion), dek]]);
      expect(verifyRestoredBankingCiphertexts([row], deks)).toBe(1);
    } finally {
      dek.fill(0);
    }
  });

  it("rejects an unrecognized non-routable banking credential marker", () => {
    const dek = generateOrganizationDek();
    try {
      const specification = RESTORED_BANKING_FIELD_SPECIFICATIONS[0]!;
      const ciphertext = serializeEncryptedField(encryptField("document-inbox-local-v2", dek, {
        organizationId,
        table: specification.tableName,
        column: specification.columnName,
        recordId,
        keyVersion,
      }));
      const row: RestoredBankingCiphertextRow = {
        organization_id: organizationId,
        record_id: recordId,
        key_version: keyVersion,
        table_name: specification.tableName,
        column_name: specification.columnName,
        ciphertext,
        provider: "FILE_IMPORT",
      };
      const deks = new Map([[restoredOrganizationKeyMapKey(organizationId, keyVersion), dek]]);
      expect(() => verifyRestoredBankingCiphertexts([row], deks)).toThrow(
        "does not match its registered provider format",
      );
    } finally {
      dek.fill(0);
    }
  });

  it("rejects the FILE_IMPORT marker on a SimpleFIN credential row", () => {
    const dek = generateOrganizationDek();
    try {
      const specification = RESTORED_BANKING_FIELD_SPECIFICATIONS[0]!;
      const ciphertext = serializeEncryptedField(encryptField("document-inbox-local-v1", dek, {
        organizationId,
        table: specification.tableName,
        column: specification.columnName,
        recordId,
        keyVersion,
      }));
      const row: RestoredBankingCiphertextRow = {
        organization_id: organizationId,
        record_id: recordId,
        key_version: keyVersion,
        table_name: specification.tableName,
        column_name: specification.columnName,
        ciphertext,
        provider: "SIMPLEFIN",
      };
      const deks = new Map([[restoredOrganizationKeyMapKey(organizationId, keyVersion), dek]]);
      expect(() => verifyRestoredBankingCiphertexts([row], deks)).toThrow(
        "does not match its registered provider format",
      );
    } finally {
      dek.fill(0);
    }
  });

  it("accepts the encrypted non-routable marker used by disabled demo connections", () => {
    const dek = generateOrganizationDek();
    try {
      const specification = RESTORED_BANKING_FIELD_SPECIFICATIONS[0]!;
      const ciphertext = serializeEncryptedField(encryptField(JSON.stringify({
        synthetic: true,
        outboundProviderCallsAllowed: false,
      }), dek, {
        organizationId,
        table: specification.tableName,
        column: specification.columnName,
        recordId,
        keyVersion,
      }));
      const row: RestoredBankingCiphertextRow = {
        organization_id: organizationId,
        record_id: recordId,
        key_version: keyVersion,
        table_name: specification.tableName,
        column_name: specification.columnName,
        ciphertext,
        provider: "SIMPLEFIN",
      };
      const deks = new Map([[restoredOrganizationKeyMapKey(organizationId, keyVersion), dek]]);
      expect(verifyRestoredBankingCiphertexts([row], deks)).toBe(1);
    } finally {
      dek.fill(0);
    }
  });

  it("rejects decrypted rule or proposal content that is not a JSON object", () => {
    const dek = generateOrganizationDek();
    try {
      const specification = RESTORED_BANKING_FIELD_SPECIFICATIONS.find(
        (candidate) => candidate.columnName === "condition_ciphertext",
      )!;
      const ciphertext = serializeEncryptedField(encryptField("[]", dek, {
        organizationId,
        table: specification.tableName,
        column: specification.columnName,
        recordId,
        keyVersion,
      }));
      const row: RestoredBankingCiphertextRow = {
        organization_id: organizationId,
        record_id: recordId,
        key_version: keyVersion,
        table_name: specification.tableName,
        column_name: specification.columnName,
        ciphertext,
        provider: null,
      };
      const deks = new Map([[restoredOrganizationKeyMapKey(organizationId, keyVersion), dek]]);
      expect(() => verifyRestoredBankingCiphertexts([row], deks)).toThrow("not an object");
    } finally {
      dek.fill(0);
    }
  });
});
