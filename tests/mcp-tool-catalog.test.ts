import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DAILY_MCP_TOOLS } from "@/modules/mcp/daily-tools";
import { INBOX_MCP_TOOLS } from "@/modules/mcp/inbox-tools";
import { SETUP_MCP_TOOLS } from "@/modules/mcp/setup-tools";
import { SHARED_MCP_TOOLS } from "@/modules/mcp/shared-tools";
import { dynamic } from "@/app/mcp/route";
import { handleMcpRequest } from "@/modules/mcp/server";

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

  it("advertises all four immutable evidence operations with their complete schemas", () => {
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

  it("forces dynamic MCP responses and prevents shared or protocol-crossing catalog caches", async () => {
    expect(dynamic).toBe("force-dynamic");

    const response = await handleMcpRequest(new Request("https://dev.business.finlynq.com/mcp", {
      headers: { authorization: "Bearer catalog-contract-token" },
    }));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Authorization, MCP-Protocol-Version");
  });
});
