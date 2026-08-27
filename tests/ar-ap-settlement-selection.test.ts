import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("document-specific settlement selection", () => {
  it("carries the posted document currency into the settlement composer", () => {
    const source = readFileSync("src/app/_components/ar-ap-workspace.client.tsx", "utf8");

    expect(source).toContain(
      "openSettlement(document.snapshot.partyAccountId, document.snapshot.currency)",
    );
    expect(source).toMatch(/party\?\.transactionCurrency\s+\?\? requestedCurrency/);
  });
});
