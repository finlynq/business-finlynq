import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptIdentityField,
} from "@/security/identity-secret";
import {
  encryptField,
  generateOrganizationDek,
  serializeEncryptedField,
} from "@/security/organization-encryption";
import {
  verifyRestoredIdentityCiphertexts,
  type RestoredIdentityCiphertextRow,
} from "../scripts/operations/restored-identity-secrets";
import {
  RESTORED_MASTER_DATA_FIELD_SPECIFICATIONS,
  restoredMasterDataCiphertextBatchQuery,
  verifyRestoredMasterDataCiphertexts,
  type RestoredMasterDataCiphertextRow,
} from "../scripts/operations/restored-master-data-secrets";
import { restoredOrganizationKeyMapKey } from "../scripts/operations/restored-banking-secrets";

const organizationId = "10000000-0000-4000-8000-000000000001";
const recordId = "20000000-0000-4000-8000-000000000001";
const userId = "30000000-0000-4000-8000-000000000001";
const keyVersion = 4;

describe("restored identity secret verification", () => {
  it("decrypts supported identity envelopes and explicitly classifies synthetic demo markers", () => {
    const identitySecret = randomBytes(64);
    try {
      const rows: RestoredIdentityCiphertextRow[] = [
        {
          id: userId,
          email_ciphertext: encryptIdentityField("owner@example.com", "email", userId, identitySecret),
          display_name_ciphertext: encryptIdentityField("Owner", "display-name", userId, identitySecret),
          is_demo: false,
        },
        {
          id: "30000000-0000-4000-8000-000000000002",
          email_ciphertext: "public-demo-sandbox-9",
          display_name_ciphertext: null,
          is_demo: true,
        },
      ];

      expect(verifyRestoredIdentityCiphertexts(rows, identitySecret)).toEqual({
        encryptedIdentities: 1,
        syntheticDemoIdentities: 1,
      });
    } finally {
      identitySecret.fill(0);
    }
  });

  it("rejects unsupported real identity ciphertext instead of filtering it away", () => {
    const identitySecret = randomBytes(64);
    try {
      expect(() => verifyRestoredIdentityCiphertexts([{
        id: userId,
        email_ciphertext: "legacy-or-corrupt-envelope",
        display_name_ciphertext: null,
        is_demo: false,
      }], identitySecret)).toThrow("unsupported identity ciphertext envelope");
    } finally {
      identitySecret.fill(0);
    }
  });

  it("does not let the demo marker exception hide an unsupported display-name envelope", () => {
    const identitySecret = randomBytes(64);
    try {
      expect(() => verifyRestoredIdentityCiphertexts([{
        id: userId,
        email_ciphertext: "public-demo",
        display_name_ciphertext: "unsupported",
        is_demo: true,
      }], identitySecret)).toThrow("unsupported identity ciphertext envelope");
    } finally {
      identitySecret.fill(0);
    }
  });
});

describe("restored party and address secret verification", () => {
  function encryptedRow(
    dek: Buffer,
    specification: (typeof RESTORED_MASTER_DATA_FIELD_SPECIFICATIONS)[number],
    overrides: Partial<RestoredMasterDataCiphertextRow> = {},
  ): RestoredMasterDataCiphertextRow {
    const plaintext = specification.plaintextKind === "address-json"
      ? JSON.stringify({ city: "Toronto", country: "CA" })
      : "Northstar Customer";
    return {
      organization_id: organizationId,
      record_id: recordId,
      key_version: keyVersion,
      table_name: specification.tableName,
      column_name: specification.columnName,
      ciphertext: serializeEncryptedField(encryptField(plaintext, dek, {
        organizationId,
        table: specification.tableName,
        column: specification.columnName,
        recordId,
        keyVersion,
      })),
      ...overrides,
    };
  }

  it("decrypts representative party and address envelopes with their exact referenced key", () => {
    const dek = generateOrganizationDek();
    try {
      const rows = RESTORED_MASTER_DATA_FIELD_SPECIFICATIONS.map((specification) => (
        encryptedRow(dek, specification)
      ));
      const deks = new Map([[restoredOrganizationKeyMapKey(organizationId, keyVersion), dek]]);
      expect(verifyRestoredMasterDataCiphertexts(rows, deks)).toBe(2);

      for (const specification of RESTORED_MASTER_DATA_FIELD_SPECIFICATIONS) {
        const query = restoredMasterDataCiphertextBatchQuery(specification);
        expect(query).toContain(`${specification.keyVersionColumn}::int AS key_version`);
        expect(query).toContain(`${specification.columnName} AS ciphertext`);
        expect(query).toContain(`FROM ${specification.tableName}`);
      }
    } finally {
      dek.fill(0);
    }
  });

  it("fails when the referenced organization key version is unavailable", () => {
    const dek = generateOrganizationDek();
    try {
      const row = encryptedRow(dek, RESTORED_MASTER_DATA_FIELD_SPECIFICATIONS[0]!);
      expect(() => verifyRestoredMasterDataCiphertexts([row], new Map())).toThrow(
        "without its exact organization key version",
      );
    } finally {
      dek.fill(0);
    }
  });

  it("fails when the database key version disagrees with the authenticated envelope", () => {
    const dek = generateOrganizationDek();
    try {
      const row = encryptedRow(dek, RESTORED_MASTER_DATA_FIELD_SPECIFICATIONS[1]!, {
        key_version: keyVersion + 1,
      });
      const deks = new Map([[restoredOrganizationKeyMapKey(organizationId, keyVersion + 1), dek]]);
      expect(() => verifyRestoredMasterDataCiphertexts([row], deks)).toThrow(
        "metadata does not match",
      );
    } finally {
      dek.fill(0);
    }
  });
});
