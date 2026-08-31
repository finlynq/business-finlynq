import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeMcpTool } from "@/modules/mcp/policy";
import {
  LocalRootKeyProvider,
  createBlindIndex,
  decryptField,
  encryptField,
  generateOrganizationDek,
  parseEncryptedField,
  parseWrappedKey,
  sameKey,
  serializeEncryptedField,
  serializeWrappedKey,
} from "@/security/organization-encryption";

describe("organization encryption and recovery boundary", () => {
  it("wraps the organization DEK independently of a user password", () => {
    const provider = new LocalRootKeyProvider(randomBytes(32));
    const dek = generateOrganizationDek();
    const wrapped = provider.wrapOrganizationKey("org-a", 1, dek);

    expect(sameKey(provider.unwrapOrganizationKey("org-a", wrapped), dek)).toBe(true);
    expect(() => provider.unwrapOrganizationKey("org-b", wrapped)).toThrow();
  });

  it("binds field ciphertext to organization, table, column, record, and key version", () => {
    const dek = generateOrganizationDek();
    const context = {
      organizationId: "org-a",
      table: "party_addresses",
      column: "ciphertext",
      recordId: "address-1",
      keyVersion: 1,
    };
    const encrypted = encryptField("100 King Street", dek, context);

    expect(decryptField(encrypted, dek, context)).toBe("100 King Street");
    expect(() => decryptField(encrypted, dek, { ...context, recordId: "address-2" })).toThrow();
  });

  it("round-trips versioned envelopes and encrypted-field serialization", () => {
    const provider = new LocalRootKeyProvider(randomBytes(32));
    const dek = generateOrganizationDek();
    const wrapped = provider.wrapOrganizationKey("org-a", 1, dek);
    expect(sameKey(provider.unwrapOrganizationKey("org-a", parseWrappedKey(serializeWrappedKey(wrapped))), dek)).toBe(true);

    const context = { organizationId: "org-a", table: "parties", column: "display_name_ciphertext", recordId: "party-a", keyVersion: 1 };
    const encrypted = parseEncryptedField(serializeEncryptedField(encryptField("Acme Corp", dek, context)));
    expect(decryptField(encrypted, dek, context)).toBe("Acme Corp");
  });

  it("creates deterministic organization-bound blind indexes without exposing plaintext", () => {
    const dek = generateOrganizationDek();
    const equivalent = createBlindIndex("  Acme   Corp  ", dek, "org-a", "parties.display-name");
    expect(createBlindIndex("acme corp", dek, "org-a", "parties.display-name")).toBe(equivalent);
    expect(createBlindIndex("acme corp", dek, "org-b", "parties.display-name")).not.toBe(equivalent);
    expect(equivalent).toMatch(/^hmac-sha256-v1:[0-9a-f]{64}$/);
    expect(equivalent).not.toContain("acme");
  });
});

describe("MCP authorization", () => {
  it("fails closed for unknown MCP tools and missing scopes", () => {
    const principal = {
      principalId: "mcp-1",
      organizationId: "org-a",
      scopes: ["ledger:read"],
    };

    expect(
      authorizeMcpTool({ principal, requestOrganizationId: "org-a", toolName: "ledger.read" }).allowed,
    ).toBe(true);
    expect(
      authorizeMcpTool({ principal, requestOrganizationId: "org-a", toolName: "journal.post" }).allowed,
    ).toBe(false);
    expect(
      authorizeMcpTool({ principal, requestOrganizationId: "org-b", toolName: "ledger.read" }).allowed,
    ).toBe(false);
  });
});
