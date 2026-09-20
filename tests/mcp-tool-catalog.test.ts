import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DAILY_MCP_TOOLS } from "@/modules/mcp/daily-tools";
import { INBOX_MCP_TOOLS } from "@/modules/mcp/inbox-tools";
import { SETUP_MCP_TOOLS } from "@/modules/mcp/setup-tools";
import { SHARED_MCP_TOOLS } from "@/modules/mcp/shared-tools";
import { dynamic } from "@/app/mcp/route";
import { handleMcpRequest, MCP_TOOL_CATALOG_REVISION } from "@/modules/mcp/server";

vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/server")>();
  return {
    ...actual,
    createMcpHandler: () => ({
      fetch: async () => new Response("{}", {
        headers: { "cache-control": "public, max-age=3600", vary: "Origin" },
      }),
    }),
    requireBearerAuth: () => async () => ({
      token: "catalog-contract-token",
      clientId: "catalog-contract-client",
      scopes: [],
    }),
  };
});

const allTools = [
  ...SHARED_MCP_TOOLS,
  ...DAILY_MCP_TOOLS,
  ...INBOX_MCP_TOOLS,
  ...SETUP_MCP_TOOLS,
];

type AdvertisedJsonSchema = Readonly<{
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
}>;

const evidenceContracts = {
  finlynq_daily_upload_document_evidence: {
    access: "WRITE",
    fields: ["byteSize", "contentBase64", "filename", "idempotencyKey", "mimeType", "module", "sha256"],
  },
  finlynq_daily_attach_document_evidence: {
    access: "WRITE",
    fields: ["assetId", "expectedVersion", "idempotencyKey", "kind", "purpose", "reason", "sourceNumber"],
  },
  finlynq_daily_download_bank_statement_evidence: {
    access: "READ",
    fields: ["assetId", "statementImportId"],
  },
  finlynq_daily_download_document_evidence: {
    access: "READ",
    fields: ["assetId", "sourceDocumentId"],
  },
  finlynq_daily_detach_document_evidence: {
    access: "WRITE",
    fields: ["assetId", "expectedVersion", "idempotencyKey", "kind", "reason", "sourceNumber"],
  },
} as const;

function advertisedSchema(name: string) {
  const tool = allTools.find((candidate) => candidate.policy.name === name);
  expect(tool, `${name} must be registered in the canonical catalog`).toBeDefined();
  const schema = z.toJSONSchema(tool!.inputSchema) as AdvertisedJsonSchema;
  return { tool: tool!, schema };
}

describe("remote MCP advertised tool catalog", () => {
  it("keeps every registered tool name unique", () => {
    const names = allTools.map((tool) => tool.policy.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("advertises all immutable evidence operations with their complete schemas", () => {
    for (const [name, expected] of Object.entries(evidenceContracts)) {
      const { tool, schema } = advertisedSchema(name);
      expect(tool.policy).toMatchObject({ group: "DAILY", access: expected.access });
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...expected.fields].sort());
      expect([...(schema.required ?? [])].sort()).toEqual([...expected.fields].sort());
    }
  });

  it("advertises server-resolved FX as optional for invoice drafts", () => {
    for (const name of [
      "finlynq_daily_create_sales_invoice",
      "finlynq_daily_create_supplier_bill",
      "finlynq_daily_edit_sales_invoice",
      "finlynq_daily_edit_supplier_bill",
    ]) {
      const { tool, schema } = advertisedSchema(name);
      expect(schema.properties).toHaveProperty("fx");
      expect(schema.required ?? []).not.toContain("fx");
      expect(tool.description).toContain("stored");
      expect(tool.description).toContain("provider");
      expect(tool.description).toContain("FX_RATE_UNAVAILABLE");
    }
  });

  it("advertises signed supplier adjustments and date-evaluated account context", () => {
    const supplier = advertisedSchema("finlynq_daily_create_supplier_bill");
    const lines = supplier.schema.properties?.lines as {
      items?: { properties?: Record<string, { enum?: string[] }> };
    };
    expect(lines.items?.properties?.lineType?.enum).toEqual(["STANDARD", "ADJUSTMENT"]);
    expect(supplier.tool.description).toContain("negative lines");
    expect(supplier.tool.description).toContain("Net credits");

    for (const name of [
      "finlynq_daily_get_accounting_context",
      "finlynq_setup_get_configuration",
    ]) {
      const { tool, schema } = advertisedSchema(name);
      expect(schema.properties).toHaveProperty("accountingDate");
      expect(schema.required ?? []).not.toContain("accountingDate");
      expect(tool.description).toContain("accounting date");
    }
  });

  it("advertises owner-only, MFA-backed correction tools with permanent reasons", () => {
    for (const name of [
      "finlynq_daily_unpost_journal",
      "finlynq_daily_delete_journal",
    ]) {
      const { tool, schema } = advertisedSchema(name);
      expect(tool.policy).toMatchObject({
        group: "DAILY",
        access: "WRITE",
        permission: "ledger.journal.administer",
        mfaRequirement: "REQUIRED",
      });
      expect(tool.destructive).toBe(true);
      expect(tool.idempotent).toBe(true);
      expect([...(schema.required ?? [])].sort()).toEqual([
        "idempotencyKey",
        "journalId",
        "reason",
      ]);
      expect(tool.description).toContain("Owner-only");
    }

    const party = advertisedSchema("finlynq_setup_update_party");
    expect(party.tool.destructive).toBe(true);
    expect(party.tool.description).toContain("Owner-only");
    expect(party.schema.required).toContain("reason");
    expect(party.schema.required).toContain("expectedDisplayName");
  });

  it("advertises a high-assurance, tenant-policy-only FX provider setup tool", () => {
    const { tool, schema } = advertisedSchema("finlynq_setup_configure_fx_provider_policy");
    expect(tool.policy).toMatchObject({
      group: "SETUP",
      access: "WRITE",
      permission: "organization.settings.manage",
      mfaRequirement: "REQUIRED",
    });
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "expectedVersion",
      "licensedAndAuthorizedUseAcknowledged",
      "maxLookbackDays",
      "providerMode",
      "reason",
    ]);
    expect([...(schema.required ?? [])].sort()).toEqual([
      "expectedVersion",
      "licensedAndAuthorizedUseAcknowledged",
      "maxLookbackDays",
      "providerMode",
      "reason",
    ]);
    expect(tool.description).toContain("STORED_ONLY");
    expect(tool.description).toContain("BANK_OF_CANADA");
    expect(tool.description).toContain("EUROPEAN_CENTRAL_BANK");
    expect(tool.description).toContain("explicit invoice or settlement FX evidence");
    expect(tool.description).toContain("licensed and authorized");
    expect(tool.description).toContain("performs no market-data request");
    expect(tool.inputSchema.safeParse({
      expectedVersion: 0,
      providerMode: "YAHOO_FINANCE_EXPERIMENTAL",
      maxLookbackDays: 5,
      licensedAndAuthorizedUseAcknowledged: true,
      reason: "Approve the controlled FX source",
    }).success).toBe(true);
    expect(tool.inputSchema.safeParse({
      expectedVersion: 0,
      providerMode: "YAHOO_FINANCE_EXPERIMENTAL",
      maxLookbackDays: 5,
      licensedAndAuthorizedUseAcknowledged: false,
      reason: "Attempt an unacknowledged source",
    }).success).toBe(false);
    for (const providerMode of ["BANK_OF_CANADA", "EUROPEAN_CENTRAL_BANK"]) {
      expect(tool.inputSchema.safeParse({
        expectedVersion: 0,
        providerMode,
        maxLookbackDays: 5,
        licensedAndAuthorizedUseAcknowledged: false,
        reason: "Select an official reference-rate source",
      }).success).toBe(true);
    }
  });

  it("advertises the compatible supplier-settlement schema and guidance", () => {
    const { tool, schema } = advertisedSchema("finlynq_daily_record_supplier_payment");
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];

    expect(tool.description).toContain("settlementAccountCombinationId");
    expect(tool.description).toContain("SHAREHOLDER_ADVANCE");
    expect(tool.description).toContain("Legacy bankAccountCombinationId remains supported for BANK");
    expect(properties).toHaveProperty("bankAccountCombinationId");
    expect(properties).toHaveProperty("settlementAccountCombinationId");
    expect(properties.settlementMethod?.enum).toEqual([
      "BANK",
      "CORPORATE_CARD",
      "SHAREHOLDER_ADVANCE",
      "EMPLOYEE_REIMBURSEMENT",
      "OTHER_NON_CASH",
    ]);
    expect(required).not.toContain("bankAccountCombinationId");
    expect(required).not.toContain("settlementAccountCombinationId");
    expect(required).not.toContain("settlementMethod");

    const id = "11111111-1111-4111-8111-111111111111";
    const common = {
      sourceNumber: "PAY-1",
      ledgerId: id,
      legalEntityId: id,
      partyAccountId: id,
      controlAccountCombinationId: id,
      periodId: id,
      accountingDate: "2026-09-04",
      settlementDate: "2026-09-04",
      currency: "CAD",
      amount: "158.20",
      fx: { rate: "1", source: "Functional currency", effectiveAt: "2026-09-04T00:00:00Z" },
      realizedFxGainAccountCombinationId: id,
      realizedFxLossAccountCombinationId: id,
      description: "Supplier settlement contract test",
      allocations: [{ openItemId: id, transactionAmount: "158.20" }],
      idempotencyKey: "catalog-contract-1",
    };
    expect(tool.inputSchema.safeParse({
      ...common,
      settlementAccountCombinationId: id,
      settlementMethod: "SHAREHOLDER_ADVANCE",
    }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ ...common, bankAccountCombinationId: id }).success).toBe(true);
    expect(tool.inputSchema.safeParse({
      ...common,
      bankAccountCombinationId: id,
      settlementMethod: "SHAREHOLDER_ADVANCE",
    }).success).toBe(false);
  });

  it("advertises a settlement-safe payable open-item lookup", () => {
    const { tool, schema } = advertisedSchema("finlynq_daily_list_payable_open_items");

    expect(tool.policy).toMatchObject({
      group: "DAILY",
      access: "READ",
      permission: "payables.read",
    });
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "asOfDate",
      "currency",
      "ledgerId",
      "legalEntityId",
      "limit",
      "partyAccountId",
      "sourceDocumentId",
      "sourceNumber",
      "statuses",
    ]);
    expect(tool.description).toContain("exact settlement IDs");
    expect(tool.description).toContain("remaining exact amounts");
    expect(tool.description).toContain("Open and partially settled items are returned by default");
  });

  it("advertises the tax filing and effective-dated mapping workflows", () => {
    for (const name of [
      "finlynq_daily_get_tax_filing_workspace",
      "finlynq_daily_create_tax_filing_workpaper",
      "finlynq_daily_list_tax_filing_workpapers",
      "finlynq_daily_preview_tax_filing_export",
      "finlynq_daily_export_tax_filing_workpaper",
      "finlynq_setup_list_tax_account_mapping_versions",
      "finlynq_setup_preview_tax_account_mappings",
      "finlynq_setup_save_tax_account_mappings",
      "finlynq_setup_deactivate_tax_account_mappings",
    ]) {
      expect(allTools.some((tool) => tool.policy.name === name), name).toBe(true);
    }
    const save = advertisedSchema("finlynq_setup_save_tax_account_mappings");
    expect(save.schema.required).toEqual(expect.arrayContaining([
      "expectedTemplateVersion",
      "expectedMappingVersion",
      "effectiveFrom",
      "reason",
      "idempotencyKey",
    ]));
    const exported = advertisedSchema("finlynq_daily_export_tax_filing_workpaper");
    expect(exported.tool.policy).toMatchObject({ access: "READ", permission: "tax.read" });
    expect(exported.schema.required).toContain("filingId");
    expect(exported.schema.required).not.toContain("expectedContentHash");
    expect(exported.tool.description).toContain("excludes ciphertext");

    const proposal = advertisedSchema("finlynq_daily_get_bank_accounting_proposal");
    expect(proposal.tool.policy).toMatchObject({ access: "READ", permission: "banking.read" });
    expect(proposal.schema.required).toEqual(["proposalId"]);
  });

  it("forces dynamic MCP responses and prevents shared or protocol-crossing catalog caches", async () => {
    expect(dynamic).toBe("force-dynamic");

    const response = await handleMcpRequest(new Request("https://stage.business.finlynq.com/mcp", {
      headers: { authorization: "Bearer catalog-contract-token" },
    }));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Authorization, MCP-Protocol-Version");
    expect(response.headers.get("x-finlynq-mcp-catalog-revision")).toBe(MCP_TOOL_CATALOG_REVISION);
    expect(MCP_TOOL_CATALOG_REVISION).toMatch(/^[a-f0-9]{64}$/);
  });
});
