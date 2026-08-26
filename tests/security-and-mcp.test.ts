import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { decideSynchronousPost } from "@/modules/ledger/auto-post-policy";
import { authorizeMcpTool } from "@/modules/mcp/policy";
import {
  LocalRootKeyProvider,
  decryptField,
  encryptField,
  generateOrganizationDek,
  sameKey,
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
});

describe("automation and MCP authorization", () => {
  it("allows only an explicitly authorized deterministic source action to post", () => {
    expect(
      decideSynchronousPost({
        origin: "USER",
        journalTypeKey: "receivables.sales-invoice",
        actorPermissions: new Set([PERMISSIONS.postJournal]),
        sourceActionExplicitlyAuthorized: true,
      }).allowed,
    ).toBe(true);

    expect(
      decideSynchronousPost({
        origin: "AI",
        journalTypeKey: "receivables.sales-invoice",
        actorPermissions: new Set([PERMISSIONS.postJournal]),
        sourceActionExplicitlyAuthorized: true,
      }).allowed,
    ).toBe(false);
  });

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
