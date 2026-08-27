import { describe, expect, it } from "vitest";
import { parseDemoResetMode } from "../scripts/demo-reset-mode";

describe("demo reset operator contract", () => {
  it("maps only the two scheduled modes", () => {
    expect(parseDemoResetMode([], "incremental")).toEqual({ mode: "incremental", nightly: false });
    expect(parseDemoResetMode([], "nightly")).toEqual({ mode: "nightly", nightly: true });
  });

  it("fails closed without an explicit mode", () => {
    expect(() => parseDemoResetMode([], undefined)).toThrow(/exactly incremental or nightly/);
    expect(() => parseDemoResetMode([], "all")).toThrow(/exactly incremental or nightly/);
  });

  it("cannot accept a tenant, sandbox, or slot selector", () => {
    for (const argument of [
      "10000000-0000-4000-8000-000000000001",
      "--organization=10000000-0000-4000-8000-000000000001",
      "--slot=1",
      "--all",
    ]) {
      expect(() => parseDemoResetMode([argument], "incremental")).toThrow(/accepts no tenant/);
    }
  });
});
