import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};

describe("local deployment preflight", () => {
  it("provides one cross-platform command for failures that can be caught before CI", () => {
    expect(packageJson.scripts?.["check:predeploy"]).toBe(
      "npm run db:check-drift && npm run journal-types:check-seed && npm run check && npm run build",
    );
  });
});
