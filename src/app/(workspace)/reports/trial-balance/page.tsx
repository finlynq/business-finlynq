import Link from "next/link";
import { exact, formatMoney } from "@/kernel/money";
import {
  loadTrialBalance,
  type TrialBalanceRow,
} from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { DemoNotice, EmptyState, PageHeader } from "../../../_components/ui";

function displayAmount(currency: string, amount: string): string {
  return formatMoney(amount, currency);
}

export default async function TrialBalancePage() {
  const principal = await requireWorkspacePrincipal("/app/reports/trial-balance");
  const rows = await loadTrialBalance(principal);
  const groups = new Map<string, {
    entityCode: string;
    ledgerCode: string;
    currency: string;
    rows: TrialBalanceRow[];
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
        totalDebit: exact(0),
        totalCredit: exact(0),
      };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.totalDebit = group.totalDebit.plus(row.debit);
    group.totalCredit = group.totalCredit.plus(row.credit);
  }

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Reports"
        title="Trial balance"
        description="Posted functional-currency balances from the tenant ledger, grouped independently by legal entity, ledger, and currency."
        actions={<Link className="primary-button" href="/app/reports/trial-balance.csv">Download CSV</Link>}
      />
      {principal.sessionMode === "demo" && (
        <DemoNotice>
          This report reflects your isolated writable sandbox. Changes persist for this browser until the seeded business is restored nightly.
        </DemoNotice>
      )}
      {groups.size ? [...groups.values()].map((group) => {
        const balanced = group.totalDebit.equals(group.totalCredit);
        return (
          <section className="panel" aria-labelledby={`trial-balance-${group.entityCode}-${group.ledgerCode}`} key={`${group.entityCode}:${group.ledgerCode}:${group.currency}`}>
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{group.ledgerCode} · functional currency</p>
                <h2 id={`trial-balance-${group.entityCode}-${group.ledgerCode}`}>{group.entityCode} · {group.currency}</h2>
              </div>
              <span className={`status-pill ${balanced ? "status-success" : "status-warning"}`}>{balanced ? "BALANCED" : "OUT OF BALANCE"}</span>
            </div>
            <div className="table-scroll" tabIndex={0} aria-label={`${group.entityCode} ${group.ledgerCode} trial balance; scroll horizontally if needed`}>
              <table>
                <caption className="sr-only">{group.entityCode} {group.ledgerCode} trial balance in {group.currency}</caption>
                <thead><tr><th scope="col">Account</th><th scope="col">Rendered key</th><th scope="col">Name</th><th scope="col">Class</th><th scope="col">Debit</th><th scope="col">Credit</th></tr></thead>
                <tbody>{group.rows.map((row) => (
                  <tr key={row.canonicalKey}>
                    <td><strong>{row.accountCode}</strong></td>
                    <td><code>{row.canonicalKey}</code></td>
                    <td>{row.accountName}</td>
                    <td>{row.accountClass}</td>
                    <td className="amount-cell">{displayAmount(group.currency, row.debit)}</td>
                    <td className="amount-cell">{displayAmount(group.currency, row.credit)}</td>
                  </tr>
                ))}</tbody>
                <tfoot><tr><th scope="row" colSpan={4}>{group.currency} total</th><td className="amount-cell"><strong>{displayAmount(group.currency, group.totalDebit.toFixed())}</strong></td><td className="amount-cell"><strong>{displayAmount(group.currency, group.totalCredit.toFixed())}</strong></td></tr></tfoot>
              </table>
            </div>
          </section>
        );
      }) : (
        <EmptyState title="No posted balances">
          Posted journal lines will appear here, grouped by entity and functional currency.
        </EmptyState>
      )}
      <div className="currency-warning"><strong>No consolidated total</strong><p>Amounts in different currencies are not added without an explicit presentation currency, rate source, and translation policy.</p></div>
    </div>
  );
}
