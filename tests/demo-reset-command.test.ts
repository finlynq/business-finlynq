import { describe, expect, it } from "vitest";
import { parseDemoResetMode } from "../scripts/demo-reset-mode";

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
});
