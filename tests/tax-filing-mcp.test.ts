import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DAILY_MCP_TOOLS } from "@/modules/mcp/daily-tools";
import { SETUP_MCP_TOOLS } from "@/modules/mcp/setup-tools";

const ids = {
  entity: "10000000-0000-4000-8000-000000000001",
  ledger: "10000000-0000-4000-8000-000000000002",
  template: "10000000-0000-4000-8000-000000000003",
  account: "10000000-0000-4000-8000-000000000004",
};

function tool(name: string) {
  const selected = [...DAILY_MCP_TOOLS, ...SETUP_MCP_TOOLS]
    .find((candidate) => candidate.policy.name === name);
  expect(selected, `${name} must be registered`).toBeDefined();
  return selected!;
}

describe("tax filing MCP lifecycle", () => {
  it("exposes the tenant-visible filing workspace under Daily read access", () => {
    const selected = tool("finlynq_daily_get_tax_filing_workspace");
    expect(selected.policy).toEqual({
      name: "finlynq_daily_get_tax_filing_workspace",
      group: "DAILY",
      access: "READ",
      permission: "tax.read",
    });
    expect(selected.inputSchema.safeParse({}).success).toBe(true);

    const setup = tool("finlynq_setup_get_tax_filing_configuration");
    expect(setup.policy).toEqual({
      name: "finlynq_setup_get_tax_filing_configuration",
      group: "SETUP",
      access: "READ",
      permission: "tax.read",
    });
    expect(setup.inputSchema.safeParse({}).success).toBe(true);
  });

  it("exposes immutable mapping versions under Setup write access", () => {
    const selected = tool("finlynq_setup_save_tax_account_mappings");
    expect(selected.policy).toMatchObject({
      group: "SETUP",
      access: "WRITE",
      permission: "tax.mappings.manage",
    });
    expect(selected.idempotent).toBe(true);
    expect(selected.inputSchema.safeParse({
      legalEntityId: ids.entity,
      ledgerId: ids.ledger,
      templateId: ids.template,
      mappings: [{
        fieldKey: "line_101",
        glAccountId: ids.account,
        balanceBasis: "NET_CREDIT",
        multiplier: "1",
      }],
      reason: "Map the reviewed revenue account",
      idempotencyKey: "tax-mapping-1",
    }).success).toBe(true);
  });

  it("exposes prepared and historical workpapers under Daily write access", () => {
    const selected = tool("finlynq_daily_create_tax_filing_workpaper");
    expect(selected.policy).toMatchObject({
      group: "DAILY",
      access: "WRITE",
      permission: "tax.filings.prepare",
    });
    expect(selected.idempotent).toBe(true);
    expect(selected.inputSchema.safeParse({
      legalEntityId: ids.entity,
      ledgerId: ids.ledger,
      templateId: ids.template,
      filingType: "PREPARED",
      periodStart: "2026-07-01",
      periodEnd: "2026-09-30",
      idempotencyKey: "tax-filing-1",
    }).success).toBe(true);
  });

  it("marks MCP tax writes with the connection source surface without publishing global templates", () => {
    const daily = readFileSync("src/modules/mcp/daily-tools.ts", "utf8");
    const setup = readFileSync("src/modules/mcp/setup-tools.ts", "utf8");
    const service = readFileSync("src/modules/tax/filing-service.ts", "utf8");

    expect(daily).toMatch(/createTaxFiling\([\s\S]*?sourceSurface: "MCP"/);
    expect(setup).toMatch(/saveTaxAccountMappings\([\s\S]*?sourceSurface: "MCP"/);
    expect(service).toContain('sourceSurface?: "API" | "MCP"');
    expect([...DAILY_MCP_TOOLS, ...SETUP_MCP_TOOLS]
      .some((candidate) => candidate.policy.name.includes("tax_filing_template"))).toBe(false);
  });
});
