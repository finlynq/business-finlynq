import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "src/app/_components/tax-filing-workspace.client.tsx",
  "utf8",
);

describe("tax filing workspace client events", () => {
  it("snapshots form values before deferred state updater callbacks run", () => {
    expect(source).toContain("const selectedAccountIds = Array.from(");
    expect(source).not.toMatch(
      /set(?:AccountSelections|BasisSelections|ManualValues|ReportedValues)\(\(current\) => \([\s\S]{0,200}event\.(?:currentTarget|target)/,
    );
  });
});
