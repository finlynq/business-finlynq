import { exact, isQuantizedMoney, sumExact } from "@/kernel/money";
import { validateUserSegmentCode } from "@/modules/ledger/account-segments";
import { decidePeriodPosting } from "@/modules/ledger/period-policy";
import {
  demoEntityDetails,
  demoSearchIndex,
  demoTrialBalanceRows,
} from "./dashboard-data";
import type {
  DemoEntityCode,
  DemoManualJournalPreviewInput,
  DemoManualJournalPreviewResult,
  DemoPreviewIssue,
  DemoSearchEntry,
  DemoSearchOptions,
  DemoTrialBalanceReport,
} from "./types";

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const CSV_FORMULA_PREFIX = /^[\s]*[=+\-@]/;

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreSearchEntry(entry: DemoSearchEntry, normalizedQuery: string, terms: readonly string[]): number {
  const normalizedTitle = normalizeSearchText(entry.title);
  const normalizedSubtitle = normalizeSearchText(entry.subtitle);
  const normalizedKeywords = normalizeSearchText(entry.keywords.join(" "));
  const haystack = `${normalizedTitle} ${normalizedSubtitle} ${normalizedKeywords}`;

  if (!terms.every((term) => haystack.includes(term))) return -1;
  if (normalizedTitle === normalizedQuery) return 400;
  if (normalizedTitle.startsWith(normalizedQuery)) return 300;
  if (normalizedTitle.includes(normalizedQuery)) return 200;
  if (normalizedSubtitle.includes(normalizedQuery)) return 150;
  return 100 + terms.filter((term) => normalizedKeywords.includes(term)).length;
}

export function searchDemoWorkspace(
  query: string,
  options: DemoSearchOptions = {},
): readonly DemoSearchEntry[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const terms = normalizedQuery.split(" ").filter(Boolean);
  const allowedKinds = options.kinds ? new Set(options.kinds) : null;
  const requestedLimit = Number.isFinite(options.limit) ? Math.trunc(options.limit ?? DEFAULT_SEARCH_LIMIT) : DEFAULT_SEARCH_LIMIT;
  const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, requestedLimit));

  return demoSearchIndex
    .map((entry, index) => ({ entry, index, score: scoreSearchEntry(entry, normalizedQuery, terms) }))
    .filter(({ entry, score }) =>
      score >= 0
      && (!allowedKinds || allowedKinds.has(entry.kind))
      && (!options.entityCode || entry.entityCode === options.entityCode),
    )
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export function getDemoTrialBalance(entityCode: DemoEntityCode): DemoTrialBalanceReport {
  const entity = demoEntityDetails.find((candidate) => candidate.code === entityCode);
  if (!entity) throw new Error(`Unknown demo entity: ${entityCode}`);

  const rows = demoTrialBalanceRows.filter((row) => row.entityCode === entityCode);
  const totalDebit = sumExact(rows.map((row) => row.debit));
  const totalCredit = sumExact(rows.map((row) => row.credit));

  return {
    demoOnly: true,
    entityCode,
    currency: entity.currency,
    rows,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    balanced: totalDebit.equals(totalCredit),
  };
}

export function escapeDemoCsvCell(value: string | number): string {
  const raw = String(value);
  const formulaSafe = CSV_FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
  return `"${formulaSafe.replaceAll('"', '""')}"`;
}

export function generateDemoTrialBalanceCsv(
  options: Readonly<{ entityCode?: DemoEntityCode }> = {},
): string {
  const entityCodes = options.entityCode
    ? [options.entityCode]
    : demoEntityDetails.map((entity) => entity.code);
  const rows: string[][] = [
    ["DEMO DATA - NOT AN OFFICIAL ACCOUNTING EXPORT"],
    ["Business Finlynq", "Northstar Demo Group", "As of", "2026-08-26"],
    [],
  ];

  for (const entityCode of entityCodes) {
    const report = getDemoTrialBalance(entityCode);
    rows.push(
      ["Entity", report.entityCode, "Currency", report.currency],
      ["Account code", "Account key", "Account name", "Class", "Debit", "Credit"],
      ...report.rows.map((row) => [
        row.accountCode,
        row.accountKey,
        row.accountName,
        row.accountClass,
        row.debit,
        row.credit,
      ]),
      ["DEMO TOTAL", "", "", "", report.totalDebit, report.totalCredit],
      [],
    );
  }

  return rows.map((row) => row.map(escapeDemoCsvCell).join(",")).join("\r\n");
}

function isCanonicalIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function validateDemoManualJournalPreview(
  input: DemoManualJournalPreviewInput,
): DemoManualJournalPreviewResult {
  const issues: DemoPreviewIssue[] = [];
  const normalizedEntityCode = input.entityCode.trim().toUpperCase();
  const entity = demoEntityDetails.find((candidate) => candidate.code === normalizedEntityCode);
  let totalDebit = exact(0);
  let totalCredit = exact(0);
  let allAmountsValid = true;

  if (!entity) {
    issues.push({ code: "ENTITY_UNKNOWN", message: "Select a known fictional demo entity" });
  }

  if (!input.description.trim()) {
    issues.push({ code: "DESCRIPTION_REQUIRED", message: "A journal description is required" });
  }

  if (!isCanonicalIsoDate(input.accountingDate)) {
    issues.push({ code: "ACCOUNTING_DATE_INVALID", message: "Accounting date must be a real YYYY-MM-DD date" });
  } else if (
    entity
    && (input.accountingDate < entity.periodStartsOn || input.accountingDate > entity.periodEndsOn)
  ) {
    issues.push({
      code: "ACCOUNTING_DATE_OUTSIDE_PERIOD",
      message: `Accounting date must fall inside ${entity.period}`,
    });
  }

  if (entity) {
    const periodDecision = decidePeriodPosting({
      state: entity.periodState,
      purpose: input.purpose,
      canPostAdjustment: input.canPostAdjustment,
    });
    if (!periodDecision.allowed) {
      issues.push({ code: periodDecision.code, message: periodDecision.reason });
    }
  }

  if (input.lines.length < 2) {
    issues.push({ code: "MINIMUM_LINES", message: "A journal preview requires at least two lines" });
  }

  input.lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const addIssue = (code: string, message: string): void => {
      issues.push({ code, message, line: lineNumber });
    };

    try {
      if (validateUserSegmentCode(line.accountCode) !== line.accountCode) {
        addIssue("ACCOUNT_CODE_NOT_CANONICAL", "Account code must be trimmed and uppercase");
      }
    } catch (error) {
      addIssue(
        "ACCOUNT_CODE_INVALID",
        error instanceof Error ? error.message : "Account code is invalid",
      );
    }

    try {
      const debit = exact(line.debitFunctional);
      const credit = exact(line.creditFunctional);
      totalDebit = totalDebit.plus(debit);
      totalCredit = totalCredit.plus(credit);

      if (debit.isNegative() || credit.isNegative()) {
        addIssue("NEGATIVE_SIDE", "Debit and credit values cannot be negative");
      }

      if (debit.isZero() === credit.isZero()) {
        addIssue("EXACTLY_ONE_SIDE", "Each line requires exactly one non-zero debit or credit");
      }

      if (entity && (!isQuantizedMoney(debit, entity.currency) || !isQuantizedMoney(credit, entity.currency))) {
        addIssue("FUNCTIONAL_PRECISION", `${entity.currency} demo amounts must use at most two decimals`);
      }
    } catch (error) {
      allAmountsValid = false;
      addIssue(
        "FUNCTIONAL_AMOUNT_INVALID",
        error instanceof Error ? error.message : "Amounts must be exact decimals",
      );
    }
  });

  if (allAmountsValid) {
    if (!totalDebit.equals(totalCredit)) {
      issues.push({
        code: "UNBALANCED",
        message: `Functional debits ${totalDebit.toFixed()} do not equal credits ${totalCredit.toFixed()}`,
      });
    }
    if (totalDebit.isZero() && totalCredit.isZero()) {
      issues.push({ code: "ZERO_JOURNAL", message: "A journal preview cannot have a zero total" });
    }
  }

  return {
    valid: issues.length === 0,
    demoOnly: true,
    wouldPersist: false,
    entityCode: normalizedEntityCode,
    currency: entity?.currency ?? null,
    periodState: entity?.periodState ?? null,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    issues,
  };
}
