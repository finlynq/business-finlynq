import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertGuidanceSize, guidancePathSchema, guidanceTokenBudget } from "@/modules/agent-guidance/model";
import { GUIDANCE_MCP_TOOLS } from "@/modules/mcp/guidance-tools";
import { safeArgumentsSummary } from "@/modules/mcp/connection-policy";

describe("agent guidance file contract", () => {
  it("accepts relative Markdown references and rejects traversal or ambiguous paths", () => {
    expect(guidancePathSchema.parse("tax/ontario-rst.md")).toBe("tax/ontario-rst.md");
    for (const path of ["../secret.md", "tax//rule.md", "/root.md", "Tax/Rule.md", "tax/rule.txt", "a/./b.md"]) {
      expect(guidancePathSchema.safeParse(path).success, path).toBe(false);
    }
  });

  it("enforces a per-file budget before persisting content", () => {
    expect(guidanceTokenBudget("A short rule.")).toBeLessThan(3_000);
    expect(() => assertGuidanceSize("A short rule.")).not.toThrow();
    expect(() => assertGuidanceSize("!".repeat(3_001))).toThrow(/split this content/);
    expect(() => assertGuidanceSize("x".repeat(12_001))).toThrow(/split this content/);
  });

  it("advertises discovery as a small read and versioned client writes separately", () => {
    const byName = new Map(GUIDANCE_MCP_TOOLS.map((tool) => [tool.policy.name, tool]));
    expect(byName.get("finlynq_guidance_get_index")?.policy).toMatchObject({ group: "SHARED", access: "READ" });
    expect(byName.get("finlynq_guidance_read_file")?.policy).toMatchObject({ group: "SHARED", access: "READ" });
    const save = byName.get("finlynq_guidance_save_client_file")!;
    expect(save.policy).toMatchObject({ group: "DAILY", access: "WRITE", permission: "organization.settings.manage" });
    const schema = z.toJSONSchema(save.inputSchema, { io: "input" });
    expect(schema.required).toEqual(["path", "summary", "content", "expectedVersion"]);
  });

  it("keeps guidance Markdown out of MCP approval summaries", () => {
    expect(safeArgumentsSummary({ path: "tax/notes.md", summary: "Private tax concern", content: "Private client facts" }))
      .toEqual({ path: "tax/notes.md", summary: "[redacted]", content: "[redacted]" });
  });
});
