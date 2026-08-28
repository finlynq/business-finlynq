import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), ...path.split("/")), "utf8");
}

describe("working-entity page defaults", () => {
  it("scopes the journal register and draft default through a server-validated context", () => {
    const register = source("src/app/(workspace)/journals/page.tsx");
    const draft = source("src/app/(workspace)/journals/new/page.tsx");
    const loader = source("src/modules/ledger/tenant-workspace.ts");

    expect(register).toContain("currentWorkspaceEntityContext(principal)");
    expect(register).toContain("entityContext.selectedEntity?.id ?? null");
    expect(draft).toContain("entity.id === entityContext.selectedEntity?.id");
    expect(draft).toContain("initialEntityId={selectedEntity?.id ?? null}");
    expect(loader).toContain("WHERE entry.organization_id = $1");
    expect(loader).toContain("entry.legal_entity_id = $4::uuid");
  });

  it("uses the validated context only as a report default and preserves explicit filters", () => {
    for (const path of [
      "src/app/(workspace)/reports/trial-balance/page.tsx",
      "src/app/(workspace)/reports/balance-sheet/page.tsx",
      "src/app/(workspace)/reports/profit-and-loss/page.tsx",
      "src/app/(workspace)/reports/account-inquiry/page.tsx",
      "src/app/(workspace)/reports/trial-balance.csv/route.ts",
    ]) {
      const report = source(path);
      expect(report).toContain("currentWorkspaceEntityContext(principal)");
      expect(report).toContain("entity: filterInput.entity ?? entityContext.selectedEntity?.id");
    }
  });
});
