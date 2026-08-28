import { describe, expect, it } from "vitest";
import {
  accountKeyDisplayTitle,
  presentAccountKey,
} from "@/modules/ledger/account-key-display";

const canonicalKey = "US01.1100.SUB1.SALES.CA01.NORTH.0000.0000.0000.0000.0000.0000.0000";

describe("account key display preferences", () => {
  it("keeps the full canonical key while hiding configured presentation segments", () => {
    const presented = presentAccountKey(canonicalKey, [
      { key: "subaccount", displayName: "Product", visible: false },
      { key: "department", displayName: "Cost center", visible: true },
      { key: "custom1", displayName: "Market", visible: true },
      { key: "custom2", displayName: "Channel", visible: false },
      { key: "custom3", displayName: "Custom 3", visible: false },
      { key: "custom4", displayName: "Custom 4", visible: false },
      { key: "custom5", displayName: "Custom 5", visible: false },
      { key: "custom6", displayName: "Custom 6", visible: false },
      { key: "custom7", displayName: "Custom 7", visible: false },
      { key: "custom8", displayName: "Custom 8", visible: false },
    ]);

    expect(presented.canonicalKey).toBe(canonicalKey);
    expect(presented.displayKey).toBe("US01.1100.SALES.CA01.NORTH");
    expect(presented.displaySegments.map((segment) => segment.displayName)).toEqual([
      "Entity",
      "Account",
      "Cost center",
      "Intercompany",
      "Market",
    ]);
    expect(accountKeyDisplayTitle(presented.displaySegments)).toContain("Cost center: SALES");
  });

  it("never hides entity or account even if malformed configuration asks for it", () => {
    const presented = presentAccountKey(canonicalKey, [
      { key: "entity", displayName: "Company", visible: false },
      { key: "account", displayName: "Natural account", visible: false },
    ]);

    expect(presented.displayKey.startsWith("US01.1100.")).toBe(true);
    expect(presented.displaySegments.slice(0, 2)).toEqual([
      { key: "entity", displayName: "Company", code: "US01" },
      { key: "account", displayName: "Natural account", code: "1100" },
    ]);
  });
});
