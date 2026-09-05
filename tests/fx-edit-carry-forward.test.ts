import { describe, expect, it } from "vitest";
import {
  editFxResolutionAction,
  sameFxEvidenceForEdit,
} from "@/modules/subledger/ar-ap-draft-commands";

const frozen = {
  rate: "0.900000000000000000",
  source: "Bank of Canada Valet API daily exchange rates",
  effectiveAt: "2026-09-03T00:00:00.000Z",
  quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT" as const,
};

describe("draft FX evidence carry-forward", () => {
  it("recognizes unchanged evidence without requiring identical decimal formatting", () => {
    expect(sameFxEvidenceForEdit({
      ...frozen,
      rate: "0.9",
      effectiveAt: "2026-09-03T00:00:00+00:00",
    }, frozen)).toBe(true);
  });

  it.each([
    { ...frozen, rate: "0.91" },
    { ...frozen, source: "Client contract override" },
    { ...frozen, effectiveAt: "2026-09-02T00:00:00.000Z" },
  ])("treats changed evidence as an explicit override", (supplied) => {
    expect(sameFxEvidenceForEdit(supplied, frozen)).toBe(false);
  });

  it("treats an omitted canonical quote convention as unchanged", () => {
    expect(sameFxEvidenceForEdit({
      rate: frozen.rate,
      source: frozen.source,
      effectiveAt: frozen.effectiveAt,
    }, frozen)).toBe(true);
  });

  it("does not carry evidence when the caller omits FX", () => {
    expect(sameFxEvidenceForEdit(undefined, frozen)).toBe(false);
  });

  it("uses explicit edit intent without reinterpreting preserve as an override", () => {
    expect(editFxResolutionAction("PRESERVE", undefined, frozen, true)).toBe("PRESERVE");
    expect(editFxResolutionAction("RESOLVE", undefined, frozen, true)).toBe("RESOLVE");
    expect(editFxResolutionAction("EXPLICIT", { ...frozen, rate: "0.91" }, frozen, true))
      .toBe("EXPLICIT");
    expect(() => editFxResolutionAction("PRESERVE", undefined, frozen, false))
      .toThrow(/unchanged currency, functional currency, and accounting date/);
    expect(() => editFxResolutionAction("EXPLICIT", undefined, frozen, true))
      .toThrow(/Explicit FX evidence is required/);
  });

  it("fails closed for a legacy matching-evidence payload after accounting facts change", () => {
    expect(() => editFxResolutionAction(undefined, frozen, frozen, false))
      .toThrow(/cannot be preserved/);
    expect(editFxResolutionAction(undefined, { ...frozen, rate: "0.91" }, frozen, false))
      .toBe("EXPLICIT");
    expect(editFxResolutionAction(undefined, undefined, frozen, false)).toBe("RESOLVE");
  });
});
