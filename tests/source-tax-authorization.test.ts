import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const draftCommands = readFileSync(join(root, "src/modules/subledger/ar-ap-draft-commands.ts"), "utf8");
const issueCommand = readFileSync(join(root, "src/modules/subledger/ar-ap-issue-command.ts"), "utf8");
const permissions = readFileSync(join(root, "src/modules/identity/permissions.ts"), "utf8");

describe("controlled source-tax authorization boundary", () => {
  it("requires the dedicated permission for create, edit, and issue operations", () => {
    expect(permissions).toContain('overrideTaxDeterminations: "tax.determinations.override"');
    expect(draftCommands.match(/PERMISSIONS\.overrideTaxDeterminations/g)).toHaveLength(2);
    expect(issueCommand).toContain("PERMISSIONS.overrideTaxDeterminations");
  });

  it("keeps source-tax review evidence inside the immutable document snapshot", () => {
    expect(draftCommands).toContain("sourceTaxOverride");
    expect(issueCommand.indexOf("overrideTaxDeterminations"))
      .toBeLessThan(issueCommand.lastIndexOf("assertSnapshotTaxDecisionsCurrent"));
  });
});
