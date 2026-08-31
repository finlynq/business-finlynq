import { describe, expect, it } from "vitest";

import {
  canonicalCommandSerialization,
  createCommandFingerprint,
  matchesStoredCommandFingerprint,
} from "@/kernel/command-fingerprint";

describe("versioned command fingerprints", () => {
  it("recursively sorts object keys while preserving array order", () => {
    const left = {
      z: { second: "2", first: "1" },
      items: [{ amount: "100.00", currency: "CAD" }, "tail"],
      a: true,
    };
    const right = {
      a: true,
      items: [{ currency: "CAD", amount: "100.00" }, "tail"],
      z: { first: "1", second: "2" },
    };

    expect(canonicalCommandSerialization(left)).toBe(canonicalCommandSerialization(right));
    expect(createCommandFingerprint("test.command", left)).toBe(
      createCommandFingerprint("test.command", right),
    );
    expect(createCommandFingerprint("test.command", { ...right, items: [...right.items].reverse() }))
      .not.toBe(createCommandFingerprint("test.command", right));
  });

  it("omits undefined object fields, preserves array positions, and keeps money strings exact", () => {
    expect(canonicalCommandSerialization({ kept: "value", omitted: undefined })).toBe(
      canonicalCommandSerialization({ kept: "value" }),
    );
    expect(canonicalCommandSerialization(["first", undefined, "third"])).toBe(
      '["first",null,"third"]',
    );
    expect(createCommandFingerprint("test.money", { amount: "100.00" })).not.toBe(
      createCommandFingerprint("test.money", { amount: "100" }),
    );
  });

  it("separates versions and command domains", () => {
    const payload = { idempotencyKey: "stable-command", amount: "25.00" };
    const current = createCommandFingerprint("ledger.journal.manual-create", payload, "v1");

    expect(createCommandFingerprint("ledger.journal.manual-create", payload, "v2")).not.toBe(current);
    expect(createCommandFingerprint("ledger.journal.full-reversal", payload, "v1")).not.toBe(current);
  });

  it("accepts current or exact legacy hashes and rejects a conflicting hash", () => {
    const fingerprints = {
      current: "current-fingerprint",
      legacy: "legacy-fingerprint",
    };

    expect(matchesStoredCommandFingerprint(fingerprints.current, fingerprints)).toBe(true);
    expect(matchesStoredCommandFingerprint(fingerprints.legacy, fingerprints)).toBe(true);
    expect(matchesStoredCommandFingerprint("another-command", fingerprints)).toBe(false);
    expect(matchesStoredCommandFingerprint(null, fingerprints)).toBe(false);
  });
});
