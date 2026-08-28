import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeRegisterPage,
  registerPageSize,
  registerPageWindow,
} from "@/modules/workspace/register-pagination";
import { normalizeSubledgerRegisterRequest } from "@/modules/subledger/workspace";

describe("server-driven register pagination", () => {
  it("uses one bounded look-ahead row without exposing it as page content", () => {
    const result = registerPageWindow(
      Array.from({ length: registerPageSize + 1 }, (_, index) => index),
      2,
    );
    expect(result.rows).toHaveLength(registerPageSize);
    expect(result.pagination).toEqual({
      page: 2,
      pageSize: registerPageSize,
      hasPrevious: true,
      hasNext: true,
    });
    expect(normalizeRegisterPage("not-a-page")).toBe(1);
    expect(normalizeRegisterPage("999999999")).toBe(10_000);
  });

  it("normalizes every AR/AP filter before tenant SQL receives it", () => {
    expect(normalizeSubledgerRegisterRequest({
      search: "  INV-1001  ",
      entityCode: "CA01",
      status: "POSTED",
      currency: "CAD",
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      due: "OVERDUE",
      page: 3,
    })).toEqual({
      filter: {
        search: "INV-1001",
        entityCode: "CA01",
        status: "POSTED",
        currency: "CAD",
        dateFrom: "2026-01-01",
        dateTo: "2026-12-31",
        due: "OVERDUE",
      },
      page: 3,
    });
  });

  it("does not retain the old silently truncated register limits", () => {
    const tenantWorkspace = readFileSync(join(process.cwd(), "src/modules/ledger/tenant-workspace.ts"), "utf8");
    const subledgerWorkspace = readFileSync(join(process.cwd(), "src/modules/subledger/workspace.ts"), "utf8");
    expect(tenantWorkspace).toContain("LIMIT $5 OFFSET $6");
    expect(tenantWorkspace).not.toContain("LIMIT 100`");
    expect(subledgerWorkspace).toContain("LIMIT $13 OFFSET $14");
    expect(subledgerWorkspace).not.toContain("LIMIT 200`");
  });
});
