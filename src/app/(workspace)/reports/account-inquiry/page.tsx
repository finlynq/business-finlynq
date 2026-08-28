import Link from "next/link";
import { formatMoney } from "@/kernel/money";
import { accountKeyDisplayTitle } from "@/modules/ledger/account-key-display";
import {
  loadAccountInquiry,
  loadReportDimensions,
  reportFilterInput,
  resolveReportSelection,
} from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { currentWorkspaceEntityContext } from "@/modules/workspace/entity-context";
import { ReportFilters, ReportNavigation } from "../../../_components/report-controls";
import { DemoNotice, EmptyState, PageHeader } from "../../../_components/ui";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AccountInquiryPage({ searchParams }: { searchParams: SearchParams }) {
  const principal = await requireWorkspacePrincipal("/app/reports/account-inquiry");
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
  const entity = dimensions.entities.find((candidate) => candidate.id === selection?.entityId);
  const account = entity?.accounts.find((candidate) => candidate.id === selection?.accountId);
  const inquiry = selection
    ? await loadAccountInquiry(principal, selection)
    : { openingBalance: "0", lines: [] };

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Reports"
        title="Account inquiry"
        description="Trace one GL account across posted journals, with transaction currency, immutable FX evidence, functional debit and credit, and a running natural balance."
      />
      <ReportNavigation active="account-inquiry" selection={selection} />
      {principal.sessionMode === "demo" && <DemoNotice>This inquiry reflects the current writable demo ledger and resets with the seeded business nightly.</DemoNotice>}
      {selection && <ReportFilters action="/app/reports/account-inquiry" dimensions={dimensions} selection={selection} showAccount />}
      {selection && account ? (
        <section className="panel" aria-labelledby="account-inquiry-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{selection.entityCode} · {selection.fromDate} to {selection.toDate}</p>
              <h2 id="account-inquiry-title">{account.code} · {account.displayName}</h2>
            </div>
            <div>
              <span className="subtle-label">Opening natural balance</span>
              <strong className="amount-cell">{formatMoney(inquiry.openingBalance, selection.currency)}</strong>
            </div>
          </div>
          {inquiry.lines.length ? (
            <div className="table-scroll" tabIndex={0} aria-label="Account activity; scroll horizontally if needed">
              <table>
                <caption className="sr-only">Posted activity for account {account.code} in {selection.currency}</caption>
                <thead><tr><th scope="col">Date / journal</th><th scope="col">Account key / memo</th><th scope="col">Transaction debit</th><th scope="col">Transaction credit</th><th scope="col">FX provenance</th><th scope="col">Functional debit</th><th scope="col">Functional credit</th><th scope="col">Running balance</th></tr></thead>
                <tbody>{inquiry.lines.map((line) => (
                  <tr key={line.id}>
                    <td><Link className="text-link compact-button" href={`/app/journals/${line.journalId}`}>Journal {line.journalNumber}</Link><small>{line.accountingDate} · {line.description}</small></td>
                    <td><code title={accountKeyDisplayTitle(line.displaySegments)}>{line.displayKey}</code><small>{line.memo ?? "No line memo"}</small></td>
                    <td className="amount-cell">{formatMoney(line.debitTransaction, line.transactionCurrency)}</td>
                    <td className="amount-cell">{formatMoney(line.creditTransaction, line.transactionCurrency)}</td>
                    <td><strong>{line.fxRate}</strong><small>{line.fxRateSource} · {line.fxRateEffectiveAt}</small></td>
                    <td className="amount-cell">{formatMoney(line.debitFunctional, selection.currency)}</td>
                    <td className="amount-cell">{formatMoney(line.creditFunctional, selection.currency)}</td>
                    <td className="amount-cell"><strong>{formatMoney(line.runningFunctionalBalance, selection.currency)}</strong></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No posted account activity">The selected account has no posted lines in this range. Its opening natural balance is shown above.</EmptyState>
          )}
        </section>
      ) : (
        <EmptyState title={selection ? "No account available" : "No reporting entity available"}>
          {selection ? "Create an active GL account for this entity before running an account inquiry." : "Create an active legal entity and primary ledger first."}
        </EmptyState>
      )}
      <div className="currency-warning"><strong>Currency evidence stays explicit</strong><p>Transaction amounts remain in their original currency. The running balance uses only {selection?.currency ?? "the selected entity’s functional currency"}; currencies are never combined implicitly.</p></div>
    </div>
  );
}
