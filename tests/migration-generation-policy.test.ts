import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("forward migration generation policy", () => {
  it("fails closed instead of generating from stale Drizzle snapshots", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const guard = readFileSync("scripts/operations/refuse-drizzle-generate.mjs", "utf8");

    expect(packageJson.scripts?.["db:generate"]).toBe(
      "node scripts/operations/refuse-drizzle-generate.mjs",
    );
    expect(guard).toContain("Automatic Drizzle migration generation is disabled");
    expect(guard).toContain("fresh and upgrade replay");
    expect(guard).toContain("process.exitCode = 1");
  });
});
