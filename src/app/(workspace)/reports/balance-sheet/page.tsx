import { exact, formatMoney } from "@/kernel/money";
import { accountKeyDisplayTitle } from "@/modules/ledger/account-key-display";
import {
  balanceSheetRows,
  loadReportDimensions,
  loadTrialBalance,
  reportFilterInput,
  resolveReportSelection,
} from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { currentWorkspaceEntityContext } from "@/modules/workspace/entity-context";
import { ReportFilters, ReportNavigation } from "../../../_components/report-controls";
import { DemoNotice, EmptyState, PageHeader } from "../../../_components/ui";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function BalanceSheetPage({ searchParams }: { searchParams: SearchParams }) {
  const principal = await requireWorkspacePrincipal("/app/reports/balance-sheet");
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
  const rows = selection ? balanceSheetRows(await loadTrialBalance(principal, selection)) : [];
  const assets = rows.filter((row) => row.accountClass === "ASSET");
  const liabilities = rows.filter((row) => row.accountClass === "LIABILITY");
  const equity = rows.filter((row) => row.accountClass === "EQUITY");
  const totalAssets = assets.reduce((sum, row) => sum.plus(row.amount), exact(0));
  const totalLiabilities = liabilities.reduce((sum, row) => sum.plus(row.amount), exact(0));
  const totalEquity = equity.reduce((sum, row) => sum.plus(row.amount), exact(0));
  const balanced = totalAssets.equals(totalLiabilities.plus(totalEquity));
  const currency = selection?.currency ?? "USD";

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Reports"
        title="Balance sheet"
        description="Functional-currency assets, liabilities, equity, and unclosed earnings from posted journal lines as of the selected end date."
      />
      <ReportNavigation active="balance-sheet" selection={selection} />
      {principal.sessionMode === "demo" && <DemoNotice>This statement reflects the current writable demo ledger and resets with the seeded business nightly.</DemoNotice>}
      {selection && <ReportFilters action="/app/reports/balance-sheet" dimensions={dimensions} selection={selection} />}
      {selection && rows.length ? (
        <section className="panel" aria-labelledby="balance-sheet-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{selection.ledgerCode} · as of {selection.toDate}</p>
              <h2 id="balance-sheet-title">{selection.entityCode} · {selection.entityName}</h2>
            </div>
            <span className={`status-pill ${balanced ? "status-success" : "status-warning"}`}>{balanced ? "BALANCED" : "OUT OF BALANCE"}</span>
          </div>
          <div className="table-scroll" tabIndex={0} aria-label="Balance sheet; scroll horizontally if needed">
            <table>
              <caption className="sr-only">Balance sheet for {selection.entityName} in {currency}</caption>
              <thead><tr><th scope="col">Class</th><th scope="col">Account</th><th scope="col">Rendered key</th><th scope="col">Name</th><th scope="col">Functional balance</th></tr></thead>
              <tbody>
                {[...assets, ...liabilities, ...equity].map((row) => (
                  <tr key={`${row.accountClass}:${row.canonicalKey}`}>
                    <td>{row.accountClass}</td>
                    <td><strong>{row.accountCode}</strong></td>
                    <td><code title={accountKeyDisplayTitle(row.displaySegments)}>{row.displayKey}</code></td>
                    <td>{row.accountName}{row.synthetic ? <small>Calculated from unclosed revenue and expense accounts</small> : null}</td>
                    <td className="amount-cell">{formatMoney(row.amount, row.currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><th scope="row" colSpan={4}>Total assets</th><td className="amount-cell"><strong>{formatMoney(totalAssets, currency)}</strong></td></tr>
                <tr><th scope="row" colSpan={4}>Total liabilities</th><td className="amount-cell"><strong>{formatMoney(totalLiabilities, currency)}</strong></td></tr>
                <tr><th scope="row" colSpan={4}>Total equity and unclosed earnings</th><td className="amount-cell"><strong>{formatMoney(totalEquity, currency)}</strong></td></tr>
                <tr><th scope="row" colSpan={4}>Liabilities + equity</th><td className="amount-cell"><strong>{formatMoney(totalLiabilities.plus(totalEquity), currency)}</strong></td></tr>
              </tfoot>
            </table>
          </div>
        </section>
      ) : (
        <EmptyState title={selection ? "No balance-sheet activity" : "No reporting entity available"}>
          {selection ? "Post journal lines to asset, liability, equity, revenue, or expense accounts to generate this statement." : "Create an active legal entity and primary ledger first."}
        </EmptyState>
      )}
      <div className="currency-warning"><strong>Functional statement</strong><p>{selection ? `${selection.entityCode} is shown only in ${selection.currency}.` : "Select an entity to establish the functional currency."} No implicit currency translation or consolidation is applied.</p></div>
    </div>
  );
}
