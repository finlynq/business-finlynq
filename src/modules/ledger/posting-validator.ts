import { exact, isQuantizedMoney, quantizeMoney, sumExact } from "@/kernel/money";
import {
  ACCOUNT_SEGMENT_KEYS,
  validateAccountSegments,
  validateUserSegmentCode,
  type AccountSegmentKey,
  type AccountSegments,
} from "./account-segments";
import { decidePeriodPosting, type PeriodState, type PostingPurpose } from "./period-policy";

export type JournalLineDraft = Readonly<{
  accountCode: string;
  accountClass: "STANDARD" | "AR_CONTROL" | "AP_CONTROL";
  accountActive: boolean;
  accountPostable: boolean;
  accountValidOnAccountingDate: boolean;
  accountCombinationActive: boolean;
  accountSegments: AccountSegments;
  requiredSegmentKeys?: readonly AccountSegmentKey[];
  inactiveSegmentKeys?: readonly AccountSegmentKey[];
  debitFunctional: string;
  creditFunctional: string;
  transactionCurrency: string;
  transactionAmount: string;
  fxRate: string;
  partyAccountId?: string;
  partyAccountRole?: "CUSTOMER" | "SUPPLIER";
  subledgerEventId?: string;
}>;

export type JournalDraft = Readonly<{
  functionalCurrency: string;
  sourceModule: string;
  purpose: PostingPurpose;
  periodState: PeriodState;
  canPostAdjustment: boolean;
  sourceDocumentId?: string;
  lines: readonly JournalLineDraft[];
}>;

export type PostingIssue = Readonly<{
  code: string;
  message: string;
  line?: number;
}>;

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function validateSourceModule(sourceModule: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(sourceModule);
}

export function validateJournalDraft(journal: JournalDraft): PostingIssue[] {
  const issues: PostingIssue[] = [];
  let functionalAmountsValid = true;
  const periodDecision = decidePeriodPosting({
    state: journal.periodState,
    purpose: journal.purpose,
    canPostAdjustment: journal.canPostAdjustment,
  });

  if (!periodDecision.allowed) {
    issues.push({ code: periodDecision.code, message: periodDecision.reason });
  }

  if (journal.lines.length < 2) {
    issues.push({ code: "MINIMUM_LINES", message: "A journal requires at least two lines" });
  }

  if (!validateSourceModule(journal.sourceModule)) {
    issues.push({
      code: "SOURCE_MODULE_INVALID",
      message: "Source module must be a non-empty canonical lowercase module key",
    });
  }

  if (!/^[A-Z]{3}$/.test(journal.functionalCurrency)) {
    issues.push({
      code: "FUNCTIONAL_CURRENCY_INVALID",
      message: "Functional currency must be a canonical ISO-style code",
    });
  }

  if (journal.sourceDocumentId !== undefined && !hasText(journal.sourceDocumentId)) {
    issues.push({
      code: "SOURCE_DOCUMENT_INVALID",
      message: "A supplied source document identifier cannot be blank",
    });
  }

  journal.lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const addIssue = (code: string, message: string): void => {
      issues.push({ code, message, line: lineNumber });
    };

    if (!line.accountActive) {
      addIssue("ACCOUNT_INACTIVE", `Account ${line.accountCode} is inactive`);
    }

    if (!line.accountPostable) {
      addIssue("ACCOUNT_NOT_POSTABLE", `Account ${line.accountCode} is not postable`);
    }

    if (!line.accountValidOnAccountingDate) {
      addIssue(
        "ACCOUNT_OUTSIDE_EFFECTIVE_DATE",
        `Account ${line.accountCode} is not effective on the accounting date`,
      );
    }

    if (!line.accountCombinationActive) {
      addIssue("ACCOUNT_COMBINATION_INACTIVE", "The account combination is inactive");
    }

    try {
      validateAccountSegments(line.accountSegments);

      for (const key of ACCOUNT_SEGMENT_KEYS) {
        const value = line.accountSegments[key];
        if (value !== null && validateUserSegmentCode(value) !== value) {
          addIssue(
            "ACCOUNT_SEGMENT_NOT_CANONICAL",
            `Segment ${key} must be trimmed and uppercase`,
          );
        }
      }

      const canonicalAccountCode = validateUserSegmentCode(line.accountCode);
      if (
        canonicalAccountCode !== line.accountCode ||
        canonicalAccountCode !== line.accountSegments.account
      ) {
        addIssue(
          "ACCOUNT_CODE_MISMATCH",
          "Account code must be canonical and match the natural-account segment",
        );
      }
    } catch (error) {
      addIssue(
        "ACCOUNT_SEGMENTS_INVALID",
        error instanceof Error ? error.message : "Account segments are invalid",
      );
    }

    for (const key of new Set(line.requiredSegmentKeys ?? [])) {
      if (line.accountSegments[key] === null) {
        addIssue("REQUIRED_SEGMENT_MISSING", `Required segment ${key} is missing`);
      }
    }

    for (const key of new Set(line.inactiveSegmentKeys ?? [])) {
      if (line.accountSegments[key] !== null) {
        addIssue("INACTIVE_SEGMENT_USED", `Inactive segment ${key} cannot be used`);
      }
    }

    let debit: ReturnType<typeof exact>;
    let credit: ReturnType<typeof exact>;

    try {
      debit = exact(line.debitFunctional);
      credit = exact(line.creditFunctional);
    } catch (error) {
      functionalAmountsValid = false;
      addIssue(
        "FUNCTIONAL_AMOUNT_INVALID",
        error instanceof Error ? error.message : "Functional amounts must be exact decimals",
      );
      return;
    }

    let transactionAmount: ReturnType<typeof exact>;
    let fxRate: ReturnType<typeof exact>;

    try {
      transactionAmount = exact(line.transactionAmount);
      fxRate = exact(line.fxRate);
    } catch (error) {
      addIssue(
        "TRANSACTION_OR_RATE_INVALID",
        error instanceof Error
          ? error.message
          : "Transaction amount and FX rate must be exact decimals",
      );
      return;
    }

    if (debit.isNegative() || credit.isNegative()) {
      addIssue("NEGATIVE_SIDE", "Debit and credit columns cannot be negative");
    }

    const hasExactlyOneFunctionalSide = debit.isZero() !== credit.isZero();
    if (!hasExactlyOneFunctionalSide) {
      addIssue("EXACTLY_ONE_SIDE", "A line must contain exactly one non-zero debit or credit");
    }

    try {
      if (
        !isQuantizedMoney(debit, journal.functionalCurrency) ||
        !isQuantizedMoney(credit, journal.functionalCurrency)
      ) {
        addIssue(
          "FUNCTIONAL_PRECISION",
          `Posted ${journal.functionalCurrency} values exceed currency precision`,
        );
      }
    } catch (error) {
      addIssue(
        "FUNCTIONAL_CURRENCY_INVALID",
        error instanceof Error ? error.message : "Functional currency is invalid",
      );
    }

    if (!/^[A-Z]{3}$/.test(line.transactionCurrency)) {
      addIssue("TRANSACTION_CURRENCY_INVALID", "Transaction currency must be a canonical ISO-style code");
    }

    try {
      if (!isQuantizedMoney(transactionAmount, line.transactionCurrency)) {
        addIssue(
          "TRANSACTION_PRECISION",
          `Posted ${line.transactionCurrency} values exceed currency precision`,
        );
      }
    } catch (error) {
      addIssue(
        "TRANSACTION_CURRENCY_INVALID",
        error instanceof Error ? error.message : "Transaction currency is invalid",
      );
    }

    if (transactionAmount.isZero()) {
      addIssue("ZERO_TRANSACTION_AMOUNT", "Transaction amount cannot be zero");
    }

    if (!fxRate.greaterThan(0)) {
      addIssue("FX_RATE_INVALID", "FX rate must be greater than zero");
    }

    if (hasExactlyOneFunctionalSide && !transactionAmount.isZero() && fxRate.greaterThan(0)) {
      const signedFunctionalAmount = debit.greaterThan(0) ? debit : credit.negated();
      if (signedFunctionalAmount.greaterThan(0) !== transactionAmount.greaterThan(0)) {
        addIssue(
          "TRANSACTION_SIDE_MISMATCH",
          "Transaction amount sign must match the functional debit or credit side",
        );
      }

      if (line.transactionCurrency === journal.functionalCurrency) {
        if (!fxRate.equals(1)) {
          addIssue(
            "FUNCTIONAL_CURRENCY_RATE_INVALID",
            "Functional-currency journal lines must use an FX rate of exactly 1",
          );
        }

        if (!transactionAmount.equals(signedFunctionalAmount)) {
          addIssue(
            "FUNCTIONAL_TRANSACTION_MISMATCH",
            "Functional-currency transaction amount must exactly equal the signed functional amount",
          );
        }
      } else {
        try {
          const expectedFunctionalAmount = quantizeMoney(
            transactionAmount.abs().times(fxRate),
            journal.functionalCurrency,
          );
          if (!expectedFunctionalAmount.equals(signedFunctionalAmount.abs())) {
            addIssue(
              "FX_AMOUNT_MISMATCH",
              "Functional amount does not equal transaction amount converted at the snapshotted FX rate",
            );
          }
        } catch (error) {
          addIssue(
            "FX_AMOUNT_INVALID",
            error instanceof Error ? error.message : "FX conversion cannot be validated",
          );
        }
      }
    }

    if (line.accountClass === "AR_CONTROL" || line.accountClass === "AP_CONTROL") {
      if (
        journal.sourceModule === "ledger" ||
        !hasText(line.partyAccountId) ||
        !hasText(line.subledgerEventId) ||
        !hasText(journal.sourceDocumentId)
      ) {
        addIssue(
          "SUBLEDGER_PROVENANCE_REQUIRED",
          "Control-account lines require a source document, source module, party account, and subledger event",
        );
      }

      const requiredRole = line.accountClass === "AR_CONTROL" ? "CUSTOMER" : "SUPPLIER";
      if (line.partyAccountRole !== requiredRole) {
        addIssue(
          "SUBLEDGER_ROLE_MISMATCH",
          `${line.accountClass} requires a ${requiredRole.toLowerCase()} party account`,
        );
      }

      const requiredModule = line.accountClass === "AR_CONTROL" ? "receivables" : "payables";
      if (journal.sourceModule !== requiredModule) {
        addIssue(
          "CONTROL_SOURCE_MODULE_MISMATCH",
          `${line.accountClass} must be owned by the ${requiredModule} module`,
        );
      }
    } else if (hasText(line.subledgerEventId)) {
      addIssue(
        "SUBLEDGER_EVENT_NOT_ALLOWED",
        "Subledger events may only be attached to AR or AP control-account lines",
      );
    }

    if (hasText(line.subledgerEventId) && !hasText(line.partyAccountId)) {
      addIssue(
        "SUBLEDGER_PROVENANCE_INCOMPLETE",
        "A subledger event must identify its party account",
      );
    }
  });

  if (!functionalAmountsValid) {
    return issues;
  }

  const debits = sumExact(journal.lines.map((line) => line.debitFunctional));
  const credits = sumExact(journal.lines.map((line) => line.creditFunctional));

  if (!debits.equals(credits)) {
    issues.push({
      code: "UNBALANCED",
      message: `Functional debits ${debits.toFixed()} do not equal credits ${credits.toFixed()}`,
    });
  }

  if (debits.isZero() && credits.isZero()) {
    issues.push({ code: "ZERO_JOURNAL", message: "A journal cannot post with a zero total" });
  }

  return issues;
}

export function assertJournalPostable(journal: JournalDraft): void {
  const issues = validateJournalDraft(journal);

  if (issues.length > 0) {
    throw new Error(issues.map((issue) => issue.message).join("; "));
  }
}
