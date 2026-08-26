import { describe, expect, it } from "vitest";
import type { AccountSegments } from "@/modules/ledger/account-segments";
import { validateJournalDraft, type JournalDraft } from "@/modules/ledger/posting-validator";

function segments(account: string): AccountSegments {
  return {
    entity: "CA01",
    account,
    subaccount: null,
    department: null,
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
}

const balancedJournal: JournalDraft = {
  functionalCurrency: "CAD",
  sourceModule: "ledger",
  purpose: "ROUTINE",
  periodState: "OPEN",
  canPostAdjustment: false,
  lines: [
    {
      accountCode: "6100",
      accountClass: "STANDARD",
      accountActive: true,
      accountPostable: true,
      accountValidOnAccountingDate: true,
      accountCombinationActive: true,
      accountSegments: segments("6100"),
      debitFunctional: "100.00",
      creditFunctional: "0",
      transactionCurrency: "CAD",
      transactionAmount: "100.00",
      fxRate: "1",
    },
    {
      accountCode: "1000",
      accountClass: "STANDARD",
      accountActive: true,
      accountPostable: true,
      accountValidOnAccountingDate: true,
      accountCombinationActive: true,
      accountSegments: segments("1000"),
      debitFunctional: "0",
      creditFunctional: "100.00",
      transactionCurrency: "CAD",
      transactionAmount: "-100.00",
      fxRate: "1",
    },
  ],
};

describe("posting controls", () => {
  it("accepts an exact balanced open-period journal", () => {
    expect(validateJournalDraft(balancedJournal)).toEqual([]);
  });

  it("rejects an imbalance without tolerances", () => {
    const journal = {
      ...balancedJournal,
      lines: [balancedJournal.lines[0], { ...balancedJournal.lines[1], creditFunctional: "99.99" }],
    };
    expect(validateJournalDraft(journal).map((issue) => issue.code)).toContain("UNBALANCED");
  });

  it("rejects every normal post into a hard-closed period", () => {
    const journal = { ...balancedJournal, periodState: "HARD_CLOSED" as const };
    expect(validateJournalDraft(journal).map((issue) => issue.code)).toContain("PERIOD_CLOSED");
  });

  it("keeps AR and AP party identity out of manual GL", () => {
    const journal = {
      ...balancedJournal,
      lines: [{ ...balancedJournal.lines[0], accountClass: "AR_CONTROL" as const }, balancedJournal.lines[1]],
    };
    expect(validateJournalDraft(journal).map((issue) => issue.code)).toContain(
      "SUBLEDGER_PROVENANCE_REQUIRED",
    );
  });

  it("requires transaction signs to follow the functional debit or credit side", () => {
    const journal = {
      ...balancedJournal,
      lines: [
        balancedJournal.lines[0],
        { ...balancedJournal.lines[1], transactionAmount: "100.00" },
      ],
    };

    expect(validateJournalDraft(journal).map((issue) => issue.code)).toContain(
      "TRANSACTION_SIDE_MISMATCH",
    );
  });

  it("requires functional-currency lines to use rate 1 and identical signed amounts", () => {
    const journal = {
      ...balancedJournal,
      lines: [
        { ...balancedJournal.lines[0], transactionAmount: "99.00", fxRate: "1.01" },
        balancedJournal.lines[1],
      ],
    };
    const codes = validateJournalDraft(journal).map((issue) => issue.code);

    expect(codes).toContain("FUNCTIONAL_CURRENCY_RATE_INVALID");
    expect(codes).toContain("FUNCTIONAL_TRANSACTION_MISMATCH");
  });

  it("accepts foreign-currency conversion rounded to functional minor units", () => {
    const journal: JournalDraft = {
      ...balancedJournal,
      lines: [
        {
          ...balancedJournal.lines[0],
          debitFunctional: "133.33",
          transactionCurrency: "USD",
          transactionAmount: "100.00",
          fxRate: "1.333333",
        },
        {
          ...balancedJournal.lines[1],
          creditFunctional: "133.33",
          transactionAmount: "-133.33",
        },
      ],
    };

    expect(validateJournalDraft(journal)).toEqual([]);
  });

  it("rejects a foreign-currency functional amount that disagrees with its rate", () => {
    const journal = {
      ...balancedJournal,
      lines: [
        {
          ...balancedJournal.lines[0],
          transactionCurrency: "USD",
          transactionAmount: "80.00",
          fxRate: "1.20",
        },
        balancedJournal.lines[1],
      ],
    };

    expect(validateJournalDraft(journal).map((issue) => issue.code)).toContain(
      "FX_AMOUNT_MISMATCH",
    );
  });

  it("rejects inactive, nonpostable, ineffective, or inactive-combination accounts", () => {
    const journal = {
      ...balancedJournal,
      lines: [
        {
          ...balancedJournal.lines[0],
          accountActive: false,
          accountPostable: false,
          accountValidOnAccountingDate: false,
          accountCombinationActive: false,
        },
        balancedJournal.lines[1],
      ],
    };
    const codes = validateJournalDraft(journal).map((issue) => issue.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        "ACCOUNT_INACTIVE",
        "ACCOUNT_NOT_POSTABLE",
        "ACCOUNT_OUTSIDE_EFFECTIVE_DATE",
        "ACCOUNT_COMBINATION_INACTIVE",
      ]),
    );
  });

  it("enforces canonical, matching, required, and active account segments", () => {
    const journal = {
      ...balancedJournal,
      lines: [
        {
          ...balancedJournal.lines[0],
          accountSegments: {
            ...balancedJournal.lines[0].accountSegments,
            account: "6200",
            department: "OPS",
          },
          requiredSegmentKeys: ["subaccount"] as const,
          inactiveSegmentKeys: ["department"] as const,
        },
        balancedJournal.lines[1],
      ],
    };
    const codes = validateJournalDraft(journal).map((issue) => issue.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        "ACCOUNT_CODE_MISMATCH",
        "REQUIRED_SEGMENT_MISSING",
        "INACTIVE_SEGMENT_USED",
      ]),
    );
  });

  it("accepts complete subledger provenance on a control-account line", () => {
    const journal: JournalDraft = {
      ...balancedJournal,
      sourceModule: "receivables",
      sourceDocumentId: "invoice-1001",
      lines: [
        {
          ...balancedJournal.lines[0],
          accountClass: "AR_CONTROL",
          partyAccountId: "customer-account-1",
          partyAccountRole: "CUSTOMER",
          subledgerEventId: "invoice-event-1",
        },
        balancedJournal.lines[1],
      ],
    };

    expect(validateJournalDraft(journal)).toEqual([]);
  });

  it("does not allow subledger events on standard GL lines", () => {
    const journal = {
      ...balancedJournal,
      lines: [
        {
          ...balancedJournal.lines[0],
          partyAccountId: "customer-account-1",
          subledgerEventId: "invoice-event-1",
        },
        balancedJournal.lines[1],
      ],
    };

    expect(validateJournalDraft(journal).map((issue) => issue.code)).toContain(
      "SUBLEDGER_EVENT_NOT_ALLOWED",
    );
  });

  it("requires AR and AP lines to use the matching party role and owning module", () => {
    const journal = {
      ...balancedJournal,
      sourceModule: "receivables",
      sourceDocumentId: "invoice-1001",
      lines: [
        {
          ...balancedJournal.lines[0],
          accountClass: "AP_CONTROL" as const,
          partyAccountId: "customer-account-1",
          partyAccountRole: "CUSTOMER" as const,
          subledgerEventId: "invoice-event-1",
        },
        balancedJournal.lines[1],
      ],
    };
    const codes = validateJournalDraft(journal).map((issue) => issue.code);

    expect(codes).toContain("SUBLEDGER_ROLE_MISMATCH");
    expect(codes).toContain("CONTROL_SOURCE_MODULE_MISMATCH");
  });
});
