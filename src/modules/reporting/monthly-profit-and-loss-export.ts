import "server-only";

import { createHash } from "node:crypto";
import { exact } from "@/kernel/money";
import {
  financialStatementDisplayLines,
  type EffectiveAccountHierarchy,
  type FinancialStatementRow,
} from "./tenant-reporting";
import type { MonthlyProfitAndLoss } from "./monthly-profit-and-loss";

export function monthlyReportFilterLabel(report: MonthlyProfitAndLoss): string {
  const selection = report.selection;
  const segments = Object.entries(selection.segmentFilters ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return [
    selection.accountCode ? `Account ${selection.accountCode}` : "All accounts",
    ...segments.map(([key, value]) => `${key}: ${value}`),
    ...(selection.combinationId ? [`Combination ${selection.combinationId}`] : []),
  ].join(" · ");
}

export type MonthlyExportRow = Readonly<{
  label: string;
  values: readonly (string | null)[];
  total: string | null;
}>;

export function monthlyReportPresentationHash(report: MonthlyProfitAndLoss, hierarchy: EffectiveAccountHierarchy | null): string {
  return createHash("sha256").update(JSON.stringify({ report: report.snapshotHash, hierarchy })).digest("hex");
}

const sum = (values: readonly string[]) => values.reduce((total, value) => total.plus(value), exact(0)).toFixed();

export function monthlyProfitAndLossExportRows(
  report: MonthlyProfitAndLoss,
  hierarchy: EffectiveAccountHierarchy | null,
): readonly MonthlyExportRow[] {
  const statementRows: FinancialStatementRow[] = report.rows.map((row) => ({ ...row, synthetic: false }));
  const result: MonthlyExportRow[] = [];
  const classTotal = (kind: "REVENUE" | "EXPENSE", key?: string) => sum(report.rows
    .filter((row) => row.accountClass === kind)
    .map((row) => key ? row.months[key] ?? "0" : row.amount));
  for (const kind of ["REVENUE", "EXPENSE"] as const) {
    result.push({ label: kind === "REVENUE" ? "Revenue" : "Expenses", values: report.columns.map(() => null), total: null });
    const lines = financialStatementDisplayLines(statementRows, hierarchy, kind);
    const monthLines = new Map(report.columns.map((column) => [column.key, new Map(
      financialStatementDisplayLines(statementRows.map((row) => ({
        ...row,
        amount: report.rows.find((candidate) => candidate.canonicalKey === row.canonicalKey)?.months[column.key] ?? "0",
      })), hierarchy, kind).map((line) => [line.id, line.kind === "GROUP" ? line.amount : line.row.amount]),
    )]));
    for (const line of lines) {
      result.push({
        label: line.kind === "GROUP" ? `${"  ".repeat(line.depth)}${line.label}`
          : `${"  ".repeat(line.depth)}${line.row.displayKey} · ${line.row.accountName}`,
        values: report.columns.map((column) => column.includedFrom
          ? monthLines.get(column.key)?.get(line.id) ?? "0" : null),
        total: line.kind === "GROUP" ? line.amount : line.row.amount,
      });
    }
    result.push({
      label: kind === "REVENUE" ? "Total revenue" : "Total expenses",
      values: report.columns.map((column) => column.includedFrom ? classTotal(kind, column.key) : null),
      total: classTotal(kind),
    });
  }
  result.push({
    label: "Net income (loss)",
    values: report.columns.map((column) => column.includedFrom
      ? exact(classTotal("REVENUE", column.key)).minus(classTotal("EXPENSE", column.key)).toFixed() : null),
    total: exact(classTotal("REVENUE")).minus(classTotal("EXPENSE")).toFixed(),
  });
  return result;
}
