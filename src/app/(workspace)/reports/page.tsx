import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/app/_components/ui";
import styles from "@/app/_components/workspace-navigation.module.css";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";

export const metadata: Metadata = { title: "Reports" };

const reports = [
  { code: "BR", title: "Booking reports", href: "/app/reports/booking-batches", description: "Review agent-prepared batches, source evidence and actual posting outcomes.", use: "Trace draft reviews, held entries and immutable posted results." },
  { code: "TB", title: "Trial balance", href: "/app/reports/trial-balance", description: "Review opening balances, debits, credits and closing balances across your chart of accounts.", use: "Use it to check ledger balance and export account totals." },
  { code: "BS", title: "Balance sheet", href: "/app/reports/balance-sheet", description: "See assets, liabilities, equity and unclosed earnings at a selected date.", use: "Use it to understand the entity’s financial position." },
  { code: "PL", title: "Profit & loss", href: "/app/reports/profit-and-loss", description: "Compare posted revenue and expenses over a fiscal period or custom date range.", use: "Use it to review performance and net income." },
  { code: "GL", title: "Account inquiry", href: "/app/reports/account-inquiry", description: "Follow an account’s opening balance, individual postings and running balance.", use: "Use it to investigate activity and trace amounts back to journals." },
] as const;

export default async function ReportsPage() {
  await requireWorkspacePrincipal("/app/reports");
  return <div className="page-content">
    <PageHeader eyebrow="Review & close" title="Reports" description="Review ledger activity or inspect an agent booking batch. Each report shows its company, period and currency." />
    <section className={styles.cards} aria-label="Accounting reports">
      {reports.map((report) => <article className={styles.card} key={report.code}>
        <span className={styles.cardMark} aria-hidden="true">{report.code}</span>
        <h2>{report.title}</h2>
        <p>{report.description}</p>
        <small>{report.use}</small>
        <Link className="text-link" href={report.href}>Open {report.title.toLowerCase()} <span aria-hidden="true">→</span></Link>
      </article>)}
    </section>
    <aside className="demo-notice" aria-label="Report scope"><span aria-hidden="true">i</span><p>Reports open for your working entity. Currencies stay separate; changing the report filters does not change your workspace’s working entity.</p></aside>
  </div>;
}
