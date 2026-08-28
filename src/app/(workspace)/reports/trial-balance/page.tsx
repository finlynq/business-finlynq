import { exact, formatMoney } from "@/kernel/money";
import { accountKeyDisplayTitle } from "@/modules/ledger/account-key-display";
import {
  loadReportDimensions,
  loadTrialBalance,
  reportFilterInput,
  reportSearchParams,
  resolveReportSelection,
  type TrialBalanceRow,
} from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { currentWorkspaceEntityContext } from "@/modules/workspace/entity-context";
import { ReportFilters, ReportNavigation } from "../../../_components/report-controls";
import { DemoNotice, EmptyState, PageHeader } from "../../../_components/ui";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function displayAmount(currency: string, amount: string): string {
  return formatMoney(amount, currency);
}

export default async function TrialBalancePage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: SearchParams;
} = {}) {
  const principal = await requireWorkspacePrincipal("/app/reports/trial-balance");
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
  const rows = selection ? await loadTrialBalance(principal, selection) : [];
  const groups = new Map<string, {
    entityCode: string;
    ledgerCode: string;
    currency: string;
    rows: TrialBalanceRow[];
    openingDebit: ReturnType<typeof exact>;
    openingCredit: ReturnType<typeof exact>;
    periodDebit: ReturnType<typeof exact>;
    periodCredit: ReturnType<typeof exact>;
    totalDebit: ReturnType<typeof exact>;
    totalCredit: ReturnType<typeof exact>;
  }>();

  for (const row of rows) {
    const key = `${row.entityCode}:${row.ledgerCode}:${row.currency}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        entityCode: row.entityCode,
        ledgerCode: row.ledgerCode,
        currency: row.currency,
        rows: [],
        openingDebit: exact(0),
        openingCredit: exact(0),
        periodDebit: exact(0),
        periodCredit: exact(0),
        totalDebit: exact(0),
        totalCredit: exact(0),
      };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.openingDebit = group.openingDebit.plus(row.openingDebit);
    group.openingCredit = group.openingCredit.plus(row.openingCredit);
    group.periodDebit = group.periodDebit.plus(row.periodDebit);
    group.periodCredit = group.periodCredit.plus(row.periodCredit);
    group.totalDebit = group.totalDebit.plus(row.debit);
    group.totalCredit = group.totalCredit.plus(row.credit);
  }
  const csvHref = selection
    ? `/app/reports/trial-balance.csv?${reportSearchParams(selection).toString()}`
    : undefined;

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Reports"
        title="Trial balance"
        description="Opening balances, posted period activity, and ending functional-currency balances for one legal entity and an explicit fiscal-period or date range."
        actions={csvHref ? <a className="primary-button" href={csvHref}>Download CSV</a> : undefined}
      />
      <ReportNavigation active="trial-balance" selection={selection} />
      {principal.sessionMode === "demo" && (
        <DemoNotice>
          This report reflects your isolated writable sandbox. Changes persist for this browser until the seeded business is restored nightly.
        </DemoNotice>
      )}
      {selection && (
        <ReportFilters
          action="/app/reports/trial-balance"
          dimensions={dimensions}
          selection={selection}
        />
      )}
      {groups.size ? [...groups.values()].map((group) => {
        const balanced = group.totalDebit.equals(group.totalCredit);
        return (
          <section className="panel" aria-labelledby={`trial-balance-${group.entityCode}-${group.ledgerCode}`} key={`${group.entityCode}:${group.ledgerCode}:${group.currency}`}>
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{group.ledgerCode} · {selection?.fromDate} to {selection?.toDate}</p>
                <h2 id={`trial-balance-${group.entityCode}-${group.ledgerCode}`}>{group.entityCode} · {group.currency}</h2>
              </div>
              <span className={`status-pill ${balanced ? "status-success" : "status-warning"}`}>{balanced ? "BALANCED" : "OUT OF BALANCE"}</span>
            </div>
            <div className="table-scroll" tabIndex={0} aria-label={`${group.entityCode} ${group.ledgerCode} trial balance; scroll horizontally if needed`}>
              <table>
                <caption className="sr-only">{group.entityCode} {group.ledgerCode} trial balance in {group.currency}</caption>
                <thead><tr><th scope="col">Account</th><th scope="col">Rendered key</th><th scope="col">Name</th><th scope="col">Class</th><th scope="col">Opening debit</th><th scope="col">Opening credit</th><th scope="col">Period debit</th><th scope="col">Period credit</th><th scope="col">Ending debit</th><th scope="col">Ending credit</th></tr></thead>
                <tbody>{group.rows.map((row) => (
                  <tr key={row.canonicalKey}>
                    <td><strong>{row.accountCode}</strong></td>
                    <td><code title={accountKeyDisplayTitle(row.displaySegments)}>{row.displayKey}</code></td>
                    <td>{row.accountName}</td>
                    <td>{row.accountClass}</td>
                    <td className="amount-cell">{displayAmount(group.currency, row.openingDebit)}</td>
                    <td className="amount-cell">{displayAmount(group.currency, row.openingCredit)}</td>
                    <td className="amount-cell">{displayAmount(group.currency, row.periodDebit)}</td>
                    <td className="amount-cell">{displayAmount(group.currency, row.periodCredit)}</td>
                    <td className="amount-cell">{displayAmount(group.currency, row.debit)}</td>
                    <td className="amount-cell">{displayAmount(group.currency, row.credit)}</td>
                  </tr>
                ))}</tbody>
                <tfoot><tr><th scope="row" colSpan={4}>{group.currency} total</th><td className="amount-cell"><strong>{displayAmount(group.currency, group.openingDebit.toFixed())}</strong></td><td className="amount-cell"><strong>{displayAmount(group.currency, group.openingCredit.toFixed())}</strong></td><td className="amount-cell"><strong>{displayAmount(group.currency, group.periodDebit.toFixed())}</strong></td><td className="amount-cell"><strong>{displayAmount(group.currency, group.periodCredit.toFixed())}</strong></td><td className="amount-cell"><strong>{displayAmount(group.currency, group.totalDebit.toFixed())}</strong></td><td className="amount-cell"><strong>{displayAmount(group.currency, group.totalCredit.toFixed())}</strong></td></tr></tfoot>
              </table>
            </div>
          </section>
        );
      }) : (
        <EmptyState title={selection ? "No posted balances" : "No reporting entity available"}>
          {selection
            ? "Posted journal lines in the selected entity and range will appear here."
            : "Create an active legal entity and primary ledger before running accounting reports."}
        </EmptyState>
      )}
      <div className="currency-warning"><strong>No implicit consolidation</strong><p>Each report is pinned to one legal entity and its functional currency. Unlike currencies are never added without an explicit translation policy.</p></div>
    </div>
  );
}
