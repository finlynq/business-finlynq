import Link from "next/link";
import { BrandLockup } from "@/app/_components/brand-lockup";
import styles from "../marketing.module.css";

export function MarketingFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerGrid}>
        <div>
          <BrandLockup inverse />
          <p>Open-source, audit-first accounting infrastructure for small businesses.</p>
        </div>
        <nav aria-label="Product links">
          <strong>Product</strong>
          <a href="#controls">Accounting controls</a>
          <a href="#multicurrency">Multicurrency</a>
          <a href="#ai">AI & MCP</a>
        </nav>
        <nav aria-label="Company links">
          <strong>Company</strong>
          <Link href="/security">Security</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
        <nav aria-label="Open-source links">
          <strong>Open source</strong>
          <a href="https://github.com/finlynq/business-finlynq" rel="noreferrer">GitHub repository</a>
          <Link href="/signup">Create account</Link>
          <Link href="/login">Sign in</Link>
          <Link href="/try-demo?next=/app" prefetch={false}>Open demo</Link>
        </nav>
      </div>
      <div className={styles.footerBottom}>
        <span>© {new Date().getUTCFullYear()} Finlynq</span>
        <span>AGPL-3.0-or-later · Demo data is synthetic</span>
      </div>
    </footer>
  );
}
