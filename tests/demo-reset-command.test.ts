import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDemoResetMode } from "../scripts/demo-reset-mode";

const resetImplementation = readFileSync(
  "src/modules/onboarding/demo-bootstrap.ts",
  "utf8",
);
const poolUpdateStart = resetImplementation.indexOf(
  "UPDATE demo_sandbox_pool SET",
);
const poolUpdateEnd = resetImplementation.indexOf(
  "RETURNING cycle",
  poolUpdateStart,
);
const poolUpdate = resetImplementation.slice(poolUpdateStart, poolUpdateEnd);

describe("demo reset operator contract", () => {
  it("accepts only the destructive nightly reconciliation mode", () => {
    expect(parseDemoResetMode([], "nightly")).toEqual({ mode: "nightly" });
  });

  it("fails closed without an explicit mode", () => {
    expect(() => parseDemoResetMode([], undefined)).toThrow(/exactly nightly/);
    expect(() => parseDemoResetMode([], "incremental")).toThrow(/exactly nightly/);
    expect(() => parseDemoResetMode([], "all")).toThrow(/exactly nightly/);
  });

  it("cannot accept a tenant, sandbox, or slot selector", () => {
    for (const argument of [
      "10000000-0000-4000-8000-000000000001",
      "--organization=10000000-0000-4000-8000-000000000001",
      "--slot=1",
      "--all",
    ]) {
      expect(() => parseDemoResetMode([argument], "nightly")).toThrow(/accepts no tenant/);
    }
  });

  it("schedules the next cycle from reconciliation completion, not the prior boundary", () => {
    expect(poolUpdateStart).toBeGreaterThanOrEqual(0);
    expect(poolUpdateEnd).toBeGreaterThan(poolUpdateStart);
    expect(poolUpdate).toContain(
      "reset_after = app.next_demo_reset_after(statement_timestamp())",
    );
    expect(poolUpdate).toContain(
      "last_completed_reset_at = statement_timestamp()",
    );
    expect(poolUpdate).not.toContain(
      "next_demo_reset_after(greatest(now(), reset_after))",
    );
  });
});
