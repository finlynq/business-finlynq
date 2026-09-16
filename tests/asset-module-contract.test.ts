import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(join(process.cwd(), "migrations/drizzle/0058_asset_register_idempotency.sql"), "utf8");
const service = readFileSync(join(process.cwd(), "src/modules/assets/service.ts"), "utf8");
const tools = readFileSync(join(process.cwd(), "src/modules/mcp/asset-tools.ts"), "utf8");
const demo = readFileSync(join(process.cwd(), "src/modules/onboarding/demo-bootstrap.ts"), "utf8");

describe("asset module integration contract", () => {
  it("forces tenant RLS and fail-closed write guards on every register table", () => {
    for (const table of ["asset_categories", "asset_register", "asset_schedule_entries", "asset_lifecycle_events"]) {
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`CREATE POLICY tenant_isolation ON ${table}`);
      expect(migration).toContain(`ON ${table}`);
    }
    expect(migration).toContain("app.current_actor_has_permission(required_permission)");
    expect(migration).toContain("Asset lifecycle events are append-only");
    expect(migration).toContain("Asset accounting identity and schedule basis are immutable");
  });

  it("validates complete schedules and exposes UI/API/MCP journal drafting", () => {
    expect(migration).toContain("asset_schedule_integrity_guard");
    expect(migration).toContain("scheduled_total <> selected_asset.cost - selected_asset.residual_value");
    expect(service).toContain("createManualJournal");
    expect(service).toContain("period.state IN ('OPEN', 'ADJUSTMENT_ONLY')");
    expect(service).toContain("asset-lifecycle:${parsed.assetId}:${parsed.idempotencyKey}");
    expect(service).toContain("remaining carrying value");
    expect(service).toContain("remainingBalance");
    expect(service).toContain('AS "costGlBalance"');
    expect(service).toContain("variance: glNet.minus(registerNet).toFixed()");
    expect(tools).toContain("finlynq_daily_asset_register");
    expect(tools).toContain("finlynq_daily_generate_asset_schedule_journal");
    expect(tools).toContain("finlynq_daily_record_asset_lifecycle");
  });

  it("seeds every asset class into the deterministic 250-transaction demo", () => {
    expect(demo).toContain("export const DEMO_TRANSACTION_COUNT = 250");
    expect(demo).toContain("DEMO_GENERATED_JOURNAL_COUNT = DEMO_TRANSACTION_COUNT - 6");
    expect(demo).toContain('kind: "TANGIBLE" as const');
    expect(demo).toContain('kind: "PREPAID" as const');
    expect(demo).toContain('classification: "INDEFINITE_LIFE" as const');
    expect(demo).toContain('asset_schedule_errors: "0"');
  });
});
