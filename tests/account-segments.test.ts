import { describe, expect, it } from "vitest";
import {
  canTransitionCustomSlot,
  renderAccountKey,
  validateUserSegmentCode,
  type AccountSegments,
} from "@/modules/ledger/account-segments";

const baseSegments: AccountSegments = {
  entity: "CA01",
  account: "6100",
  subaccount: null,
  department: "OPS",
  intercompany: null,
  custom1: null,
  custom2: null,
  custom3: null,
  custom4: null,
  custom5: null,
  custom6: null,
  custom7: null,
  custom8: null,
};

describe("typed account segments", () => {
  it("renders all 13 fields while retaining null internally", () => {
    expect(renderAccountKey(baseSegments)).toBe(
      "CA01.6100.0000.OPS.0000.0000.0000.0000.0000.0000.0000.0000.0000",
    );
  });

  it("reserves the null display code", () => {
    expect(() => validateUserSegmentCode("0000")).toThrow(/reserved/);
  });

  it("allows an unused custom definition to reset only through restricted administration", () => {
    expect(
      canTransitionCustomSlot({
        from: "CONFIGURED_UNBOUND",
        to: "EMPTY",
        hasProtectedUse: false,
        hasRestrictedAdminApproval: true,
      }),
    ).toBe(true);

    expect(
      canTransitionCustomSlot({
        from: "ACTIVE_LOCKED",
        to: "EMPTY",
        hasProtectedUse: true,
        hasRestrictedAdminApproval: true,
      }),
    ).toBe(false);
  });
});
