import { describe, expect, it } from "vitest";
import { groupTaxFilingHistory, partitionTaxFilingHistory } from "@/modules/tax/filing-history";

type Filing = Parameters<typeof partitionTaxFilingHistory>[0][number];

const templates = [
  { id: "t2-v1", templateKey: "ca.t2", version: 1 },
  { id: "t2-v2", templateKey: "ca.t2", version: 2 },
  { id: "hst-v2", templateKey: "ca.gst-hst.return", version: 2 },
];

function filing(id: string, override: Partial<Filing> = {}): Filing {
  return {
    id,
    legalEntityId: "entity-a",
    ledgerId: "ledger-a",
    templateId: "t2-v2",
    periodStart: "2025-01-01",
    periodEnd: "2025-12-31",
    canonical: false,
    lifecycleState: "HISTORICAL",
    capturedAt: "2026-10-14T00:00:00Z",
    ...override,
  };
}

describe("tax filing history", () => {
  it("places canonical T2 ahead of newer same-period versions and keeps HST separate", () => {
    const canonical = filing("canonical", { templateId: "t2-v1", canonical: true, capturedAt: "2026-10-01T00:00:00Z" });
    const newer = filing("newer", { capturedAt: "2026-10-14T00:00:00Z" });
    const hst = filing("hst", { templateId: "hst-v2" });
    const result = partitionTaxFilingHistory([newer, hst, canonical], templates);
    expect(result.current.map((item) => item.id)).toEqual(["hst", "canonical"]);
    expect(result.history.map((item) => item.id)).toEqual(["newer"]);
  });

  it("labels the latest eligible unselected version as a candidate and retains inactive records", () => {
    const older = filing("older", { capturedAt: "2026-10-01T00:00:00Z" });
    const latest = filing("latest", { lifecycleState: "CURRENT" });
    const archived = filing("archived", { lifecycleState: "ARCHIVED", capturedAt: "2026-10-20T00:00:00Z" });
    const result = partitionTaxFilingHistory([older, latest, archived], templates);
    expect(result.current.map((item) => item.id)).toEqual(["latest"]);
    expect(result.history.map((item) => item.id)).toEqual(["archived", "older"]);
  });

  it("never groups different entities or ledgers into the same current selection", () => {
    const result = partitionTaxFilingHistory([
      filing("a"),
      filing("b", { legalEntityId: "entity-b" }),
      filing("c", { ledgerId: "ledger-b" }),
    ], templates);
    expect(result.current).toHaveLength(3);
    expect(result.history).toHaveLength(0);
  });

  it("keeps separate tax registrations in separate filing-history scopes", () => {
    const result = partitionTaxFilingHistory([
      filing("registration-a", { registrationId: "registration-a" }),
      filing("registration-b", { registrationId: "registration-b" }),
    ], templates);
    expect(result.current.map((item) => item.id).sort()).toEqual(["registration-a", "registration-b"]);
    expect(result.history).toHaveLength(0);
  });

  it("groups different template versions as alternatives within the same registration and period", () => {
    const groups = groupTaxFilingHistory([
      filing("old", { templateId: "t2-v1", registrationId: "reg-1" }),
      filing("new", { templateId: "t2-v2", registrationId: "reg-1" }),
      filing("other", { templateId: "t2-v2", registrationId: "reg-2" }),
    ], templates);
    expect(groups.map((group) => group.filings.map((item) => item.id))).toEqual([["old", "new"], ["other"]]);
  });
});
