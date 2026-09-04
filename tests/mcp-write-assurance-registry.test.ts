import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mcpToolRequiresStepUp } from "@/modules/mcp/connection-policy";
import { SETUP_MCP_TOOLS } from "@/modules/mcp/setup-tools";

describe("MCP Setup write assurance registry", () => {
  it("declares supplier creation as the only reviewed Setup MFA exception", () => {
    const writes = SETUP_MCP_TOOLS.filter((tool) => tool.policy.access === "WRITE");
    const ordinary = writes.filter((tool) => !mcpToolRequiresStepUp(tool.policy));

    expect(ordinary.map((tool) => tool.policy.name)).toEqual(["finlynq_setup_create_party"]);
    expect(ordinary[0]?.policy).toMatchObject({
      actionClass: "PARTY",
      mfaRequirement: "NOT_REQUIRED",
    });
    expect(writes.filter((tool) => tool.policy.name !== "finlynq_setup_create_party")
      .every((tool) => mcpToolRequiresStepUp(tool.policy))).toBe(true);
  });

  it("passes the delegated browser session to the database period-transition guard", () => {
    const source = readFileSync("src/modules/mcp/setup-tools.ts", "utf8");
    expect(source).toContain(
      'mutationContext(runtime.sessionPrincipal, runtime.requestId, { reason: args.reason, sourceSurface: "MCP" })',
    );
    expect(source).not.toContain(
      "transitionFiscalPeriod({ context: mcpMutationContext(runtime.principal",
    );
  });
});
