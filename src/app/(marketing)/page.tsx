import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter } from "./_components/marketing-footer";
import { MarketingHeader } from "./_components/marketing-header.client";
import { ProductPreview } from "./_components/product-preview";
import styles from "./marketing.module.css";

export const metadata: Metadata = {
  title: "Open-source accounting with an audit trail",
  description: "A modular, multicurrency accounting foundation for small businesses, with period controls, immutable posting history, and governed AI access.",
  alternates: { canonical: "/" },
};

const capabilities = [
  { key: "GL", title: "General ledger", text: "Balanced entries, source-owned journals, role-based posting, and corrections by reversal." },
  { key: "AR", title: "Receivables", text: "Customer accounts, invoices, open items, tax decisions, and traceable subledger events." },
  { key: "AP", title: "Payables", text: "Supplier bills, due-date visibility, control accounts, and a shared party address book." },
  { key: "TX", title: "Modular tax", text: "Versioned jurisdiction packs designed first for Ontario and Washington, without hardwiring one country." },
] as const;

export default function MarketingHomePage() {
  const signupEnabled = process.env.ACCOUNT_SIGNUP_ENABLED === "true" &&
    process.env.ACCOUNT_LOGIN_ENABLED === "true";
  return (
    <div className={styles.site}>
      <a className={styles.skipLink} href="#main-content">Skip to main content</a>
      <MarketingHeader />
      <main id="main-content">
        <section className={styles.hero}>
          <div className={styles.heroGlow} aria-hidden="true" />
          <div className={styles.heroInner}>
            <div className={styles.heroCopy}>
              <p className={styles.kicker}>Open-source accounting for small businesses</p>
              <h1>Close the books with confidence.</h1>
              <p className={styles.heroLead}>Business Finlynq is a modular ERP foundation for teams that need multicurrency books, strong period controls, and a history that cannot quietly disappear.</p>
              <div className={styles.heroActions}>
                <Link className={styles.primaryCta} href="/try-demo?next=/app" prefetch={false}>Explore the live demo <span aria-hidden="true">→</span></Link>
                {signupEnabled && <Link className={styles.secondaryCta} href="/signup">Create account</Link>}
                <Link className={styles.secondaryCta} href="/login">Sign in</Link>
              </div>
              <ul className={styles.trustList} aria-label="Product principles">
                <li>U.S. & Canada foundation</li><li>Multicurrency by design</li><li>Audit-first</li><li>AGPL open source</li>
              </ul>
              <p className={styles.demoNote}>Each browser receives an isolated synthetic business for the day. Try the accounting workflows, return after logout if needed, and expect the seeded setup to return nightly.</p>
            </div>
            <div className={styles.heroPreview}><ProductPreview /></div>
          </div>
        </section>

        <section id="product" className={styles.capabilitySection} aria-labelledby="capability-title">
          <div className={styles.sectionIntro}>
            <p className={styles.kicker}>One accounting core</p>
            <h2 id="capability-title">A clean foundation, expanded in modules.</h2>
            <p>Start with the workflows a small business needs today. Add inventory, projects, manufacturing, insurance, or other vertical modules without redesigning the ledger.</p>
          </div>
          <div className={styles.capabilityGrid}>
            {capabilities.map((item) => <article key={item.key}><span>{item.key}</span><h3>{item.title}</h3><p>{item.text}</p></article>)}
          </div>
        </section>

        <section id="controls" className={styles.controlSection} aria-labelledby="controls-title">
          <div className={styles.controlStory}>
            <p className={styles.kicker}>Control without bureaucracy</p>
            <h2 id="controls-title">The system remembers what happened.</h2>
            <p>Entries are drafts until an authorized role posts them. Posted history is corrected through linked reversals. Closed periods narrow the path further, preserving evidence instead of relying on hidden delete buttons.</p>
            <div className={styles.controlRules}>
              <div><b>01</b><span><strong>Source ownership</strong><small>AP entries return to AP. AR entries return to AR.</small></span></div>
              <div><b>02</b><span><strong>Period state</strong><small>Open, adjustment-only, hard-closed, and sealed behavior.</small></span></div>
              <div><b>03</b><span><strong>Corrections, not erasure</strong><small>Void and reversal preserve who changed what and why.</small></span></div>
            </div>
          </div>
          <aside className={styles.auditCard} aria-label="Illustrative journal lifecycle">
            <p>Journal lifecycle</p>
            <ol>
              <li><span>Draft</span><small>Editable by its source module</small></li>
              <li><span>Validated</span><small>Balanced and policy checked</small></li>
              <li><span>Posted</span><small>Immutable accounting event</small></li>
              <li><span>Corrected</span><small>Linked reversal preserves lineage</small></li>
            </ol>
          </aside>
        </section>

        <section id="multicurrency" className={styles.currencySection} aria-labelledby="currency-title">
          <div className={styles.currencyVisual} aria-hidden="true">
            <div><span>Transaction</span><strong>10,000.00 USD</strong></div>
            <i>× 1.35620</i>
            <div><span>Functional</span><strong>13,562.00 CAD</strong></div>
            <p>Rate source · date · precision · rounding · gain/loss</p>
          </div>
          <div>
            <p className={styles.kicker}>Multicurrency that stays explainable</p>
            <h2 id="currency-title">Never silently add unlike currencies.</h2>
            <p>Every posting keeps transaction and functional amounts, the applied rate, and its source. Current reports keep unlike currencies separate; policy-driven translation is planned as a later module.</p>
            <ul className={styles.checkList}><li>Entity-level functional currency</li><li>Versioned exchange-rate provenance</li><li>Realized and unrealized gain/loss policy</li></ul>
          </div>
        </section>

        <section id="ai" className={styles.aiSection} aria-labelledby="ai-title">
          <div>
            <p className={styles.kicker}>AI with the same permission boundary</p>
            <h2 id="ai-title">Useful automation. Governed access.</h2>
          </div>
          <p>Business Finlynq is being designed for future MCP access without creating a second security model. No public MCP endpoint is active in this preview. When enabled, reads and draft proposals will remain bounded by the user’s organization permissions, while posting, period close, and key administration stay explicit privileges.</p>
          <div className={styles.scopeStrip}><span>Read</span><span>Draft</span><span>Validate</span><span className={styles.lockedScope}>Post · privileged</span></div>
        </section>

        <section id="open-source" className={styles.openSourceSection} aria-labelledby="open-title">
          <div>
            <p className={styles.kicker}>Open by default</p>
            <h2 id="open-title">Own the code. Own the deployment path.</h2>
            <p>Business Finlynq is published under AGPL-3.0-or-later. The application, PostgreSQL database, encryption secrets, and edge configuration stay isolated so the service can move to another host without untangling it from Finlynq.</p>
          </div>
          <div className={styles.repoCard}>
            <span>finlynq / business-finlynq</span>
            <code>github.com/finlynq/business-finlynq</code>
            <a href="https://github.com/finlynq/business-finlynq" rel="noreferrer">View the repository <span aria-hidden="true">↗</span></a>
          </div>
        </section>

        <section className={styles.finalCta} aria-labelledby="final-title">
          <p className={styles.kicker}>See the control model in context</p>
          <h2 id="final-title">Walk through a focused synthetic business.</h2>
          <p>No registration and no credentials to type. Sessions last up to one hour with a 15-minute idle limit; the same browser can reopen its private synthetic business until the nightly reset.</p>
          <div><Link href="/try-demo?next=/app" prefetch={false}>Open the live demo <span aria-hidden="true">→</span></Link>{signupEnabled && <Link href="/signup">Create account</Link>}<Link href="/login">Sign in</Link></div>
        </section>
      </main>
      <MarketingFooter />
    </div>
  );
}
