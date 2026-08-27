import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("demo bootstrap CLI boundary", () => {
  it("uses the transaction posting engine without importing Next-only write policy", () => {
    const bootstrap = readFileSync("src/modules/onboarding/demo-bootstrap.ts", "utf8");
    const engine = readFileSync("src/modules/ledger/posting-engine.ts", "utf8");

    expect(bootstrap).toContain('from "@/modules/ledger/posting-engine"');
    expect(bootstrap).not.toContain('from "@/modules/ledger/posting-service"');
    expect(engine).not.toContain('import "server-only"');
    expect(engine).not.toContain("@/modules/workspace/write-policy");
  });
});
