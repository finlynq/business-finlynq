import { exact, formatMoneyAmount } from "@/kernel/money";
import {
  balanceSheetRows,
  financialStatementDisplayLines,
  loadEffectiveAccountHierarchy,
  loadReportDimensions,
  loadTrialBalance,
  reportFilterInput,
  reportSegmentCode,
  reportSegmentColumns,
  resolveReportSelection,
} from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { currentWorkspaceEntityContext } from "@/modules/workspace/entity-context";
import { ReportFilters, ReportNavigation } from "../../../_components/report-controls";
import { DemoNotice, EmptyState, PageHeader } from "../../../_components/ui";
import styles from "../financial-statements.module.css";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function displayAmount(currency: string, amount: string): string {
  return formatMoneyAmount(amount, currency);
}

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
  const [trialBalance, hierarchy] = selection
    ? await Promise.all([
        loadTrialBalance(principal, selection),
        loadEffectiveAccountHierarchy(principal, selection),
      ])
    : [[], null] as const;
  const rows = balanceSheetRows(trialBalance);
  const assets = rows.filter((row) => row.accountClass === "ASSET");
  const liabilities = rows.filter((row) => row.accountClass === "LIABILITY");
  const equity = rows.filter((row) => row.accountClass === "EQUITY");
  const totalAssets = assets.reduce((sum, row) => sum.plus(row.amount), exact(0));
  const totalLiabilities = liabilities.reduce((sum, row) => sum.plus(row.amount), exact(0));
  const totalEquity = equity.reduce((sum, row) => sum.plus(row.amount), exact(0));
  const balanced = totalAssets.equals(totalLiabilities.plus(totalEquity));
  const currency = selection?.currency ?? "USD";
  const segmentColumns = reportSegmentColumns(rows);
  const sections = [
    { key: "ASSET", label: "Assets", totalLabel: "Total assets", rows: assets, total: totalAssets, lines: financialStatementDisplayLines(rows, hierarchy, "ASSET") },
    { key: "LIABILITY", label: "Liabilities", totalLabel: "Total liabilities", rows: liabilities, total: totalLiabilities, lines: financialStatementDisplayLines(rows, hierarchy, "LIABILITY") },
    { key: "EQUITY", label: "Equity", totalLabel: "Total equity and unclosed earnings", rows: equity, total: totalEquity, lines: financialStatementDisplayLines(rows, hierarchy, "EQUITY") },
  ] as const;

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Reports"
        title="Balance sheet"
        description="Functional-currency assets, liabilities, equity, and unclosed earnings from posted journal lines as of the selected end date."
      />
      <ReportNavigation active="balance-sheet" selection={selection} />
      {principal.sessionMode === "demo" && <DemoNotice>This statement reflects the current writable demo ledger and resets with the seeded business nightly.</DemoNotice>}
      {selection && <ReportFilters action="/app/reports/balance-sheet" dimensions={dimensions} selection={selection} showDimensions />}
      {selection && rows.length ? (
        <section className="panel" aria-labelledby="balance-sheet-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{selection.ledgerCode} · as of {selection.toDate}{hierarchy ? ` · ${hierarchy.displayName} v${hierarchy.version}` : " · class hierarchy"}</p>
              <h2 id="balance-sheet-title">{selection.entityCode} · {selection.entityName}</h2>
            </div>
            <span className={`status-pill ${balanced ? "status-success" : "status-warning"}`}>{balanced ? "BALANCED" : "OUT OF BALANCE"}</span>
          </div>
          <div className="table-scroll" tabIndex={0} aria-label="Balance sheet; scroll horizontally if needed">
            <table>
              <caption className="sr-only">Balance sheet for {selection.entityName} in {currency}</caption>
              <thead><tr>
                <th scope="col">Line item</th>
                {segmentColumns.map((column) => <th scope="col" key={column.key}>{column.displayName}</th>)}
                <th scope="col">Currency</th><th scope="col">Balance</th>
              </tr></thead>
              {sections.map((section) => (
                <tbody key={section.key}>
                  <tr className={styles.sectionHeading}>
                    <th scope="rowgroup" colSpan={segmentColumns.length + 1}>{section.label}</th>
                    <td>{currency}</td><td aria-hidden="true" />
                  </tr>
                  {section.lines.map((line) => line.kind === "GROUP" ? (
                    <tr key={line.id} className={styles.hierarchyGroup}>
                      <th scope="rowgroup" colSpan={segmentColumns.length + 1} style={{ paddingInlineStart: `${24 + line.depth * 20}px` }}>{line.label}</th>
                      <td>{currency}</td><td className="amount-cell">{displayAmount(currency, line.amount)}</td>
                    </tr>
                  ) : (
                    <tr key={line.id}>
                      <th className={styles.leafName} scope="row" style={{ paddingInlineStart: `${24 + line.depth * 20}px` }}>{line.row.accountName}{line.row.synthetic ? <small>Calculated from unclosed revenue and expense accounts</small> : null}</th>
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
                <tr className={styles.grandTotal}><th scope="row" colSpan={segmentColumns.length + 1}>Total assets</th><td>{currency}</td><td className="amount-cell"><strong>{displayAmount(currency, totalAssets.toFixed())}</strong></td></tr>
                <tr className={styles.grandTotal}><th scope="row" colSpan={segmentColumns.length + 1}>Liabilities + equity</th><td>{currency}</td><td className="amount-cell"><strong>{displayAmount(currency, totalLiabilities.plus(totalEquity).toFixed())}</strong></td></tr>
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
