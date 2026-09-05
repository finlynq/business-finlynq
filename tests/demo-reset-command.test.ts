import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDemoResetMode } from "../scripts/demo-reset-mode";

const resetImplementation = readFileSync(
  "src/modules/onboarding/demo-bootstrap.ts",
  "utf8",
);
const stateUpdateStart = resetImplementation.indexOf(
  "UPDATE shared_demo_reset_state SET",
);
const stateUpdateEnd = resetImplementation.indexOf(
  "RETURNING baseline_version",
  stateUpdateStart,
);
const stateUpdate = resetImplementation.slice(stateUpdateStart, stateUpdateEnd);

describe("demo reset operator contract", () => {
  it("accepts only the destructive nightly reconciliation mode", () => {
    expect(parseDemoResetMode([], "nightly")).toEqual({ mode: "nightly" });
  });

  it("fails closed without an explicit mode", () => {
    expect(() => parseDemoResetMode([], undefined)).toThrow(/exactly nightly/);
    expect(() => parseDemoResetMode([], "incremental")).toThrow(/exactly nightly/);
    expect(() => parseDemoResetMode([], "all")).toThrow(/exactly nightly/);
  });

  it("cannot accept a tenant, organization, or other selector", () => {
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
    expect(stateUpdateStart).toBeGreaterThanOrEqual(0);
    expect(stateUpdateEnd).toBeGreaterThan(stateUpdateStart);
    expect(stateUpdate).toContain(
      "reset_after = app.next_demo_reset_after(statement_timestamp())",
    );
    expect(stateUpdate).toContain(
      "last_completed_reset_at = statement_timestamp()",
    );
    expect(stateUpdate).not.toContain(
      "next_demo_reset_after(greatest(now(), reset_after))",
    );
  });

  it("resets on nightly runs, overdue bootstrap, failure, or baseline upgrade", () => {
    expect(resetImplementation).toContain(
      "reset_after <= statement_timestamp() AS reset_due",
    );
    expect(resetImplementation).toContain(
      'const shouldReset = options.mode === "nightly" || state.status !== "READY"',
    );
    expect(resetImplementation).toContain(
      "state.baseline_version < DEMO_BASELINE_VERSION || state.reset_due",
    );
    expect(resetImplementation).toContain(
      "WHERE organization_id = $1 AND session_mode = 'DEMO' AND revoked_at IS NULL",
    );
    expect(resetImplementation).toContain("purgeSharedDemoBusinessData(client, DEMO_ORGANIZATION_ID)");
    expect(resetImplementation).not.toContain("listSandboxCandidates");
  });
});
