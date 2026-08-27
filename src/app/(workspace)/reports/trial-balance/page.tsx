import Link from "next/link";
import { demoEntityDetails, demoTrialBalanceRows } from "@/modules/demo/dashboard-data";
import { getDemoTrialBalance } from "@/modules/demo/workspace";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { TenantModuleUnavailable } from "../../../_components/tenant-module-unavailable";
import { DemoNotice, PageHeader } from "../../../_components/ui";

export default async function TrialBalancePage() {
  const principal = await requireWorkspacePrincipal("/app/reports/trial-balance");
  if (principal.sessionMode !== "demo") return <TenantModuleUnavailable moduleName="Trial balance" />;
  const reports = demoEntityDetails.map((entity) => ({ entity, report: getDemoTrialBalance(entity.code) }));
  return (
    <div className="page-content">
      <PageHeader eyebrow="Reports" title="Trial balance" description="Functional-currency entity summaries for the August 2026 sample period. No cross-currency total is calculated." actions={<Link className="primary-button" href="/app/reports/trial-balance.csv">Download demo CSV</Link>} />
      <DemoNotice>Every row is fictional demo data. Each entity balances independently in its functional currency; CAD and USD are never added together.</DemoNotice>
      {reports.map(({ entity, report }) => (
        <section className="panel" aria-labelledby={`trial-balance-${entity.code}`} key={entity.code}>
          <div className="panel-heading"><div><p className="eyebrow">{entity.profile} · {entity.period}</p><h2 id={`trial-balance-${entity.code}`}>{entity.code} · {entity.currency}</h2></div><span className="status-pill status-success">BALANCED</span></div>
          <div className="table-scroll" tabIndex={0} aria-label={`${entity.code} trial balance; scroll horizontally if needed`}><table><caption className="sr-only">{entity.name} demo trial balance</caption><thead><tr><th scope="col">Account</th><th scope="col">Rendered key</th><th scope="col">Name</th><th scope="col">Class</th><th scope="col">Debit</th><th scope="col">Credit</th></tr></thead><tbody>{demoTrialBalanceRows.filter((row) => row.entityCode === entity.code).map((row) => <tr key={row.id}><td><strong>{row.accountCode}</strong></td><td><code>{row.accountKey}</code></td><td>{row.accountName}</td><td>{row.accountClass}</td><td className="amount-cell">{row.debit}</td><td className="amount-cell">{row.credit}</td></tr>)}</tbody><tfoot><tr><th scope="row" colSpan={4}>Demo total</th><td className="amount-cell"><strong>{report.totalDebit}</strong></td><td className="amount-cell"><strong>{report.totalCredit}</strong></td></tr></tfoot></table></div>
        </section>
      ))}
      <div className="currency-warning"><strong>No consolidated total</strong><p>Adding CAD and USD without a selected presentation currency, rate source, and translation policy would be misleading.</p></div>
    </div>
  );
}
