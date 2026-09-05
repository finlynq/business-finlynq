import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fiscalPeriodCreationSchema,
  fiscalPeriodCreationResultSchema,
} from "@/modules/ledger/accounting-configuration";
import { PERMISSIONS, ROLE_TEMPLATES } from "@/modules/identity/permissions";

const migration = readFileSync(
  join(process.cwd(), "migrations/drizzle/0039_create_fiscal_periods.sql"),
  "utf8",
);
const setupTools = readFileSync(
  join(process.cwd(), "src/modules/mcp/setup-tools.ts"),
  "utf8",
);
const runtimeRole = readFileSync(
  join(process.cwd(), "deploy/postgres/010-runtime-role.sh"),
  "utf8",
);

describe("fiscal-period creation", () => {
  it("accepts only a monthly calendar year opened with a permanent reason", () => {
    const parsed = fiscalPeriodCreationSchema.parse({
      ledgerId: "11111111-1111-4111-8111-111111111111",
      fiscalYear: 2026,
      periodPattern: "MONTHLY",
      initialState: "OPEN",
      idempotencyKey: "  ledger-2026  ",
      reason: "Create the 2026 fiscal calendar",
    });
    expect(parsed.idempotencyKey).toBe("ledger-2026");
    expect(fiscalPeriodCreationSchema.safeParse({
      ...parsed,
      periodPattern: "QUARTERLY",
    }).success).toBe(false);
    expect(fiscalPeriodCreationSchema.safeParse({
      ...parsed,
      initialState: "HARD_CLOSED",
    }).success).toBe(false);
    expect(fiscalPeriodCreationSchema.safeParse({
      ...parsed,
      reason: "short",
    }).success).toBe(false);
  });

  it("validates the structured created, existing, and rejected result contract", () => {
    const periods = Array.from({ length: 12 }, (_, index) => {
      const month = String(index + 1).padStart(2, "0");
      return {
        periodId: "11111111-1111-4111-8111-111111111111",
        periodNumber: index + 1,
        label: `Period ${index + 1}`,
        startsOn: `2026-${month}-01`,
        endsOn: `2026-${month}-28`,
        state: "OPEN" as const,
        outcome: index === 0 ? "ALREADY_EXISTING" as const : "CREATED" as const,
        rejectionCode: null,
      };
    });
    expect(fiscalPeriodCreationResultSchema.parse({
      accepted: true,
      idempotentReplay: false,
      ledgerId: "22222222-2222-4222-8222-222222222222",
      fiscalYear: 2026,
      periodPattern: "MONTHLY",
      initialState: "OPEN",
      summary: { created: 11, existing: 1, rejected: 0 },
      periods,
      conflicts: [],
    }).summary).toEqual({ created: 11, existing: 1, rejected: 0 });
  });

  it("grants the capability only to owner and approving-accountant templates", () => {
    expect(PERMISSIONS.createPeriod).toBe("ledger.period.create");
    expect(ROLE_TEMPLATES.OWNER).toContain(PERMISSIONS.createPeriod);
    expect(ROLE_TEMPLATES.ACCOUNTANT_APPROVER).toContain(PERMISSIONS.createPeriod);
    expect(ROLE_TEMPLATES.ORGANIZATION_ADMIN).not.toContain(PERMISSIONS.createPeriod);
    expect(ROLE_TEMPLATES.BOOKKEEPER_MAKER).not.toContain(PERMISSIONS.createPeriod);
    expect(ROLE_TEMPLATES.INTEGRATION_MCP).not.toContain(PERMISSIONS.createPeriod);
  });

  it("uses one audited security-definer transaction with overlap and replay fences", () => {
    expect(migration).toContain("app.accounting_create_fiscal_periods(");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("app.organization_admin_authorize('ledger.period.create', true)");
    expect(migration).toContain("|fiscal-period-request|");
    expect(migration).toContain("|ledger-calendar|");
    expect(migration).toContain("daterange(period.starts_on, period.ends_on, '[]')");
    expect(migration).not.toContain("ON CONFLICT (ledger_id, fiscal_year, period_number) DO NOTHING");
    expect(migration).toContain("'ledger.fiscal_periods.provisioned'");
    expect(migration).toContain("'commandHash', selected_command_hash");
    expect(migration).toContain("REVOKE ALL ON FUNCTION app.accounting_create_fiscal_periods(");
  });

  it("publishes an idempotent high-assurance Setup tool without direct period INSERT", () => {
    expect(setupTools).toContain('name: "finlynq_setup_create_fiscal_periods"');
    expect(setupTools).toContain("permission: PERMISSIONS.createPeriod");
    expect(setupTools).toContain("inputSchema: fiscalPeriodCreationSchema");
    expect(setupTools).toContain("idempotent: true");
    expect(setupTools).toContain('sourceSurface: "MCP"');
    expect(runtimeRole).toContain(
      "app.accounting_create_fiscal_periods(uuid,integer,text,period_state,text)",
    );
    expect(runtimeRole).not.toMatch(
      /GRANT\s+INSERT[^;]*ON\s+TABLE\s+public\.fiscal_periods/i,
    );
  });
});
