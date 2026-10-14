import { exact, formatMoneyAmount } from "@/kernel/money";
import {
  financialStatementDisplayLines,
  loadEffectiveAccountHierarchy,
  loadReportDimensions,
  loadTrialBalance,
  profitAndLossRows,
  reportFilterInput,
  reportSearchParams,
  reportSegmentCode,
  reportSegmentColumns,
  resolveReportSelection,
} from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { currentWorkspaceEntityContext } from "@/modules/workspace/entity-context";
import { loadMonthlyProfitAndLoss, MonthlyReportScopeError, monthlyReportAsOfDate, monthlyReportSelectionInput } from "@/modules/reporting/monthly-profit-and-loss";
import { monthlyReportPresentationHash } from "@/modules/reporting/monthly-profit-and-loss-export";
import { ReportFilters, ReportNavigation } from "../../../_components/report-controls";
import { RouteTabs } from "../../../_components/route-tabs";
import { DemoNotice, EmptyState, PageHeader } from "../../../_components/ui";
import { MonthlyProfitAndLossTable } from "./monthly-table";
import { MonthlyReportPrintButton } from "./print-button.client";
import styles from "../financial-statements.module.css";
import printStyles from "./monthly-print.module.css";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function displayAmount(currency: string, amount: string): string {
  return formatMoneyAmount(amount, currency);
}

export default async function ProfitAndLossPage({ searchParams }: { searchParams: SearchParams }) {
  const principal = await requireWorkspacePrincipal("/app/reports/profit-and-loss");
  const [dimensions, entityContext, query] = await Promise.all([
    loadReportDimensions(principal),
    currentWorkspaceEntityContext(principal),
    searchParams,
  ]);
  const filterInput = reportFilterInput(query);
  const byMonth = query.view === "month";
  const selectedInput = byMonth
    ? monthlyReportSelectionInput(dimensions, { ...filterInput, entity: filterInput.entity ?? entityContext.selectedEntity?.id })
    : filterInput;
  const selection = resolveReportSelection(dimensions, {
    ...selectedInput,
    entity: selectedInput.entity ?? entityContext.selectedEntity?.id,
  });
  const [trialBalance, hierarchy] = selection
    ? await Promise.all([
        byMonth ? Promise.resolve([]) : loadTrialBalance(principal, selection),
        loadEffectiveAccountHierarchy(principal, selection),
      ])
    : [[], null] as const;
  const entity = dimensions.entities.find((candidate) => candidate.id === selection?.entityId);
  let monthly: Awaited<ReturnType<typeof loadMonthlyProfitAndLoss>> | null = null;
  let monthlyError: string | null = null;
  if (byMonth && selection && entity) {
    try {
      monthly = await loadMonthlyProfitAndLoss(principal, selection, entity, monthlyReportAsOfDate(principal));
    } catch (error) {
      if (error instanceof MonthlyReportScopeError) monthlyError = error.message;
      else throw error;
    }
  }
  const rows = profitAndLossRows(trialBalance);
  const revenue = rows.filter((row) => row.accountClass === "REVENUE");
  const expenses = rows.filter((row) => row.accountClass === "EXPENSE");
  const totalRevenue = revenue.reduce((sum, row) => sum.plus(row.amount), exact(0));
  const totalExpenses = expenses.reduce((sum, row) => sum.plus(row.amount), exact(0));
  const netIncome = totalRevenue.minus(totalExpenses);
  const currency = selection?.currency ?? "USD";
  const segmentColumns = reportSegmentColumns(rows);
  const sections = [
    { key: "REVENUE", label: "Revenue", totalLabel: "Total revenue", rows: revenue, total: totalRevenue, lines: financialStatementDisplayLines(rows, hierarchy, "REVENUE") },
    { key: "EXPENSE", label: "Expenses", totalLabel: "Total expenses", rows: expenses, total: totalExpenses, lines: financialStatementDisplayLines(rows, hierarchy, "EXPENSE") },
  ] as const;
  const totalQuery = selection ? reportSearchParams(selection).toString() : "";
  const monthlyQuery = selection ? reportSearchParams(selection) : null;
  if (monthlyQuery && !["from", "to", "fromPeriod", "toPeriod"].some((key) => query[key] !== undefined)) {
    for (const key of ["from", "to", "fromPeriod", "toPeriod"]) monthlyQuery.delete(key);
  }
  monthlyQuery?.set("view", "month");
  const exportQuery = monthly && selection ? reportSearchParams(selection) : null;
  if (exportQuery && monthly) exportQuery.set("snapshot", monthlyReportPresentationHash(monthly, hierarchy));

  return (
    <div className="page-content">
      <div className={`${printStyles.controls} ${byMonth ? printStyles.noPrint : ""}`}>
      <PageHeader
        eyebrow="Reports"
        title="Profit & loss"
        description="Posted revenue and expense activity for one legal entity over the selected fiscal-period or exact-date range."
      />
      <ReportNavigation active="profit-and-loss" selection={selection} />
      {principal.sessionMode === "demo" && <DemoNotice>This statement reflects the current writable demo ledger and resets with the seeded business nightly.</DemoNotice>}
      {selection && <ReportFilters action="/app/reports/profit-and-loss" dimensions={dimensions} selection={selection} showDimensions view={byMonth ? "month" : "total"} />}
      {selection && <RouteTabs label="Profit and loss view" active={byMonth ? "month" : "total"} tabs={[
        { key: "total", label: "Total", href: `/app/reports/profit-and-loss?${totalQuery}` },
        { key: "month", label: "By month", href: `/app/reports/profit-and-loss?${monthlyQuery?.toString() ?? "view=month"}` },
      ]} />}
      {monthly && exportQuery && <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
        <a className="secondary-button" href={`/app/reports/profit-and-loss.xlsx?${exportQuery}`}>Download XLSX</a>
        <MonthlyReportPrintButton />
      </div>}
      </div>
      {monthly && entity && <MonthlyProfitAndLossTable report={monthly} entity={entity} hierarchy={hierarchy} />}
      {monthlyError && <EmptyState title="Monthly report needs a complete fiscal year">{monthlyError}</EmptyState>}
      {!byMonth && selection && rows.length ? (
        <section className="panel" aria-labelledby="profit-loss-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{selection.ledgerCode} · {selection.fromDate} to {selection.toDate}{hierarchy ? ` · ${hierarchy.displayName} v${hierarchy.version}` : " · class hierarchy"}</p>
              <h2 id="profit-loss-title">{selection.entityCode} · {selection.entityName}</h2>
            </div>
            <span className={`status-pill ${netIncome.isNegative() ? "status-warning" : "status-success"}`}>{netIncome.isNegative() ? "NET LOSS" : "NET INCOME"}</span>
          </div>
          <div className="table-scroll" tabIndex={0} aria-label="Profit and loss statement; scroll horizontally if needed">
            <table>
              <caption className="sr-only">Profit and loss for {selection.entityName} in {currency}</caption>
              <thead><tr>
                <th scope="col">Line item</th>
                {segmentColumns.map((column) => <th scope="col" key={column.key}>{column.displayName}</th>)}
                <th scope="col">Currency</th><th scope="col">Activity</th>
              </tr></thead>
              {sections.map((section) => (
                <tbody key={section.key}>
                  <tr className={styles.sectionHeading}>
                    <th scope="rowgroup" colSpan={segmentColumns.length + 1}>{section.label}</th>
                    <td>{currency}</td><td aria-hidden="true" />
                  </tr>
                  {section.lines.map((line) => line.kind === "GROUP" ? (
                    <tr key={line.id} className={styles.hierarchyGroup}>
                      <th scope="rowgroup" colSpan={segmentColumns.length + 1} style={{ paddingInlineStart: `${16 + line.depth * 16}px` }}>{line.label}</th>
                      <td>{currency}</td><td className="amount-cell">{displayAmount(currency, line.amount)}</td>
                    </tr>
                  ) : (
                    <tr key={line.id}>
                      <th className={styles.leafName} scope="row" style={{ paddingInlineStart: `${16 + line.depth * 16}px` }}>{line.row.accountName}</th>
                      {segmentColumns.map((column) => <td key={column.key}><code>{reportSegmentCode(line.row, column.key)}</code></td>)}
                      <td>{line.row.currency}</td>
                      <td className="amount-cell">{displayAmount(line.row.currency, line.row.amount)}</td>
                    </tr>
                  ))}
                  <tr className={styles.subtotal}>
                    <th scope="row" colSpan={segmentColumns.length + 1}>{section.totalLabel}</th>
                    <td>{currency}</td>
                    <td className="amount-cell"><strong>{displayAmount(currency, section.total.toFixed())}</strong></td>
                  </tr>
                </tbody>
              ))}
              <tfoot>
                <tr className={styles.grandTotal}><th scope="row" colSpan={segmentColumns.length + 1}>Net income (loss)</th><td>{currency}</td><td className="amount-cell"><strong>{displayAmount(currency, netIncome.toFixed())}</strong></td></tr>
              </tfoot>
            </table>
          </div>
        </section>
      ) : !byMonth ? (
        <EmptyState title={selection ? "No profit-and-loss activity" : "No reporting entity available"}>
          {selection ? "No posted revenue or expense lines fall within the selected range." : "Create an active legal entity and primary ledger first."}
        </EmptyState>
      ) : null}
      <div className={`currency-warning ${byMonth ? printStyles.noPrint : ""}`}><strong>Functional statement</strong><p>{selection ? `${selection.entityCode} is shown only in ${selection.currency}.` : "Select an entity to establish the functional currency."} No implicit currency translation or consolidation is applied.</p></div>
    </div>
  );
}
export const metadata = { title: "Profit & loss" };
