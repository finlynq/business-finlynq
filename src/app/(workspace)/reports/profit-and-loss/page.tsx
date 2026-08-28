import { exact, formatMoney } from "@/kernel/money";
import { accountKeyDisplayTitle } from "@/modules/ledger/account-key-display";
import {
  loadReportDimensions,
  loadTrialBalance,
  profitAndLossRows,
  reportFilterInput,
  resolveReportSelection,
} from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { currentWorkspaceEntityContext } from "@/modules/workspace/entity-context";
import { ReportFilters, ReportNavigation } from "../../../_components/report-controls";
import { DemoNotice, EmptyState, PageHeader } from "../../../_components/ui";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ProfitAndLossPage({ searchParams }: { searchParams: SearchParams }) {
  const principal = await requireWorkspacePrincipal("/app/reports/profit-and-loss");
  const [dimensions, entityContext, query] = await Promise.all([
    loadReportDimensions(principal),
    currentWorkspaceEntityContext(principal),
    searchParams,
  ]);
  const filterInput = reportFilterInput(query);
  const selection = resolveReportSelection(dimensions, {
    ...filterInput,
    entity: filterInput.entity ?? entityContext.selectedEntity?.id,
  });
  const rows = selection ? profitAndLossRows(await loadTrialBalance(principal, selection)) : [];
  const revenue = rows.filter((row) => row.accountClass === "REVENUE");
  const expenses = rows.filter((row) => row.accountClass === "EXPENSE");
  const totalRevenue = revenue.reduce((sum, row) => sum.plus(row.amount), exact(0));
  const totalExpenses = expenses.reduce((sum, row) => sum.plus(row.amount), exact(0));
  const netIncome = totalRevenue.minus(totalExpenses);
  const currency = selection?.currency ?? "USD";

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Reports"
        title="Profit & loss"
        description="Posted revenue and expense activity for one legal entity over the selected fiscal-period or exact-date range."
      />
      <ReportNavigation active="profit-and-loss" selection={selection} />
      {principal.sessionMode === "demo" && <DemoNotice>This statement reflects the current writable demo ledger and resets with the seeded business nightly.</DemoNotice>}
      {selection && <ReportFilters action="/app/reports/profit-and-loss" dimensions={dimensions} selection={selection} />}
      {selection && rows.length ? (
        <section className="panel" aria-labelledby="profit-loss-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{selection.ledgerCode} · {selection.fromDate} to {selection.toDate}</p>
              <h2 id="profit-loss-title">{selection.entityCode} · {selection.entityName}</h2>
            </div>
            <span className={`status-pill ${netIncome.isNegative() ? "status-warning" : "status-success"}`}>{netIncome.isNegative() ? "NET LOSS" : "NET INCOME"}</span>
          </div>
          <div className="table-scroll" tabIndex={0} aria-label="Profit and loss statement; scroll horizontally if needed">
            <table>
              <caption className="sr-only">Profit and loss for {selection.entityName} in {currency}</caption>
              <thead><tr><th scope="col">Class</th><th scope="col">Account</th><th scope="col">Rendered key</th><th scope="col">Name</th><th scope="col">Functional activity</th></tr></thead>
              <tbody>{[...revenue, ...expenses].map((row) => (
                <tr key={`${row.accountClass}:${row.canonicalKey}`}>
                  <td>{row.accountClass}</td>
                  <td><strong>{row.accountCode}</strong></td>
                  <td><code title={accountKeyDisplayTitle(row.displaySegments)}>{row.displayKey}</code></td>
                  <td>{row.accountName}</td>
                  <td className="amount-cell">{formatMoney(row.amount, row.currency)}</td>
                </tr>
              ))}</tbody>
              <tfoot>
                <tr><th scope="row" colSpan={4}>Total revenue</th><td className="amount-cell"><strong>{formatMoney(totalRevenue, currency)}</strong></td></tr>
                <tr><th scope="row" colSpan={4}>Total expenses</th><td className="amount-cell"><strong>{formatMoney(totalExpenses, currency)}</strong></td></tr>
                <tr><th scope="row" colSpan={4}>Net income (loss)</th><td className="amount-cell"><strong>{formatMoney(netIncome, currency)}</strong></td></tr>
              </tfoot>
            </table>
          </div>
        </section>
      ) : (
        <EmptyState title={selection ? "No profit-and-loss activity" : "No reporting entity available"}>
          {selection ? "No posted revenue or expense lines fall within the selected range." : "Create an active legal entity and primary ledger first."}
        </EmptyState>
      )}
      <div className="currency-warning"><strong>Functional statement</strong><p>{selection ? `${selection.entityCode} is shown only in ${selection.currency}.` : "Select an entity to establish the functional currency."} No implicit currency translation or consolidation is applied.</p></div>
    </div>
  );
}
