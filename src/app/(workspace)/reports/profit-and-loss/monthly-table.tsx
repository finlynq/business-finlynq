import { exact, formatMoneyAmount } from "@/kernel/money";
import {
  financialStatementDisplayLines,
  reportSearchParams,
  type EffectiveAccountHierarchy,
  type FinancialStatementRow,
  type ReportEntityOption,
} from "@/modules/reporting/tenant-reporting";
import type { MonthlyProfitAndLoss, MonthlyProfitAndLossRow } from "@/modules/reporting/monthly-profit-and-loss";
import { monthlyReportFilterLabel } from "@/modules/reporting/monthly-profit-and-loss-export";
import styles from "../financial-statements.module.css";
import printStyles from "./monthly-print.module.css";

function sum(values: readonly string[]): string {
  return values.reduce((total, value) => total.plus(value), exact(0)).toFixed();
}

function cellLink(report: MonthlyProfitAndLoss, entity: ReportEntityOption, row: MonthlyProfitAndLossRow, from: string, to: string): string | null {
  const account = entity.accounts.find((candidate) => candidate.code === row.accountCode);
  if (!account) return null;
  const query = reportSearchParams({
    ...report.selection,
    basis: "date",
    fromDate: from,
    toDate: to,
    fromPeriodId: null,
    toPeriodId: null,
    accountId: account.id,
    accountCode: row.accountCode,
    segmentFilters: {},
  });
  query.set("combination", row.combinationId);
  return `/app/reports/account-inquiry?${query}`;
}

export function MonthlyProfitAndLossTable({
  report,
  entity,
  hierarchy,
}: {
  report: MonthlyProfitAndLoss;
  entity: ReportEntityOption;
  hierarchy: EffectiveAccountHierarchy | null;
}) {
  const { rows, columns, selection } = report;
  const currency = selection.currency;
  const statementRows: FinancialStatementRow[] = rows.map((row) => ({ ...row, synthetic: false }));
  const groupColumns = new Map(columns.map((column) => [column.key, new Map(
    financialStatementDisplayLines(statementRows.map((row) => ({
      ...row,
      amount: rows.find((candidate) => candidate.canonicalKey === row.canonicalKey)?.months[column.key] ?? "0",
    })), hierarchy, "REVENUE").concat(financialStatementDisplayLines(statementRows.map((row) => ({
      ...row,
      amount: rows.find((candidate) => candidate.canonicalKey === row.canonicalKey)?.months[column.key] ?? "0",
    })), hierarchy, "EXPENSE")).map((line) => [line.id, line.kind === "GROUP" ? line.amount : line.row.amount]),
  )]));
  const sections = (["REVENUE", "EXPENSE"] as const).map((kind) => ({
    kind,
    label: kind === "REVENUE" ? "Revenue" : "Expenses",
    totalLabel: kind === "REVENUE" ? "Total revenue" : "Total expenses",
    rows: rows.filter((row) => row.accountClass === kind),
    lines: financialStatementDisplayLines(statementRows, hierarchy, kind),
  }));
  const sectionTotal = (kind: "REVENUE" | "EXPENSE", key?: string) => sum(
    rows.filter((row) => row.accountClass === kind)
      .map((row) => key ? row.months[key] ?? "0" : row.amount),
  );
  const net = (key?: string) => exact(sectionTotal("REVENUE", key)).minus(sectionTotal("EXPENSE", key)).toFixed();
  const money = (amount: string) => formatMoneyAmount(amount, currency);

  return (
    <section className={`panel ${printStyles.report}`} aria-labelledby="monthly-profit-loss-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{selection.ledgerCode} · fiscal {report.fiscalYear} · {selection.basis} basis · as of {report.asOfDate}</p>
          <h2 id="monthly-profit-loss-title">{selection.entityCode} · Monthly profit &amp; loss</h2>
          <p>{selection.entityName} · {monthlyReportFilterLabel(report)}</p>
          <p>Posted activity in {currency}, {selection.fromDate} to {selection.toDate}. Partial, future and excluded months are labelled.</p>
          <p className={printStyles.snapshot}>Snapshot SHA-256: <code>{report.snapshotHash}</code></p>
        </div>
      </div>
      <div className="table-scroll" tabIndex={0} aria-label="Monthly profit and loss; scroll horizontally if needed">
        <table>
          <caption className="sr-only">Monthly profit and loss for {selection.entityName} in {currency}</caption>
          <thead><tr>
            <th scope="col">Line item</th>
            {columns.map((column) => <th scope="col" key={column.key}>
              {column.label}<br /><small>{column.coverage.toLowerCase()}{column.periodState ? ` · ${column.periodState.toLowerCase()}` : ""}</small>
            </th>)}
            <th scope="col">Selected total</th>
          </tr></thead>
          {sections.map((section) => <tbody key={section.kind}>
            <tr className={styles.sectionHeading}><th scope="rowgroup" colSpan={columns.length + 2}>{section.label}</th></tr>
            {section.lines.map((line) => line.kind === "GROUP" ? (
              <tr key={line.id} className={styles.hierarchyGroup}>
                <th scope="rowgroup" style={{ paddingInlineStart: `${16 + line.depth * 16}px` }}>{line.label}</th>
                {columns.map((column) => <td className="amount-cell" key={column.key}>
                  {column.includedFrom ? money(groupColumns.get(column.key)?.get(line.id) ?? "0") : "—"}
                </td>)}
                <td className="amount-cell">{money(line.amount)}</td>
              </tr>
            ) : (
              <tr key={line.id}>
                <th scope="row" style={{ paddingInlineStart: `${16 + line.depth * 16}px` }}>{line.row.accountName}<small><code>{line.row.displayKey}</code></small></th>
                {columns.map((column) => {
                  const monthlyRow = rows.find((row) => row.canonicalKey === line.row.canonicalKey);
                  const amount = monthlyRow?.months[column.key] ?? "0";
                  const href = monthlyRow && column.includedFrom && column.includedTo
                    ? cellLink(report, entity, monthlyRow, column.includedFrom, column.includedTo)
                    : null;
                  return <td className="amount-cell" key={column.key}>
                    {!column.includedFrom ? "—" : href ? <a href={href}>{money(amount)}</a> : money(amount)}
                  </td>;
                })}
                <td className="amount-cell">{money(line.row.amount)}</td>
              </tr>
            ))}
            <tr className={styles.subtotal}>
              <th scope="row">{section.totalLabel}</th>
              {columns.map((column) => <td className="amount-cell" key={column.key}>{column.includedFrom ? money(sectionTotal(section.kind, column.key)) : "—"}</td>)}
              <td className="amount-cell"><strong>{money(sectionTotal(section.kind))}</strong></td>
            </tr>
          </tbody>)}
          <tfoot><tr className={styles.grandTotal}>
            <th scope="row">Net income (loss)</th>
            {columns.map((column) => <td className="amount-cell" key={column.key}>{column.includedFrom ? money(net(column.key)) : "—"}</td>)}
            <td className="amount-cell"><strong>{money(net())}</strong></td>
          </tr></tfoot>
        </table>
      </div>
    </section>
  );
}
