import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { assertPermission } from "@/modules/subledger/ar-ap-access";
import { PERMISSIONS } from "@/modules/identity/permissions";

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

const reviewContext = { organizationId: "10000000-0000-4000-8000-000000000001", actorId: "10000000-0000-4000-8000-000000000002", requestId: "source-tax-permission", authMethod: "password+mfa", sourceSurface: "API" as const };
it("gives a safe, actionable denial when source-tax review permission is absent", async () => {
  const client = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
  await expect(assertPermission(client, reviewContext, PERMISSIONS.overrideTaxDeterminations)).rejects.toMatchObject({
    code: "SOURCE_TAX_AUTHORIZATION_REQUIRED", remediation: expect.stringContaining("tax.determinations.override"),
  });
});
it("preserves database failures instead of misreporting them as missing tax-review permission", async () => {
  const failure = new Error("Synthetic database unavailable");
  const client = { query: async () => { throw failure; } } as unknown as PoolClient;
  await expect(assertPermission(client, reviewContext, PERMISSIONS.overrideTaxDeterminations)).rejects.toBe(failure);
});
