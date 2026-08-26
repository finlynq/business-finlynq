import Link from "next/link";
import { BrandLockup } from "@/app/_components/brand-lockup";
import styles from "../legal.module.css";

export function LegalPage({
  eyebrow,
  title,
  intro,
  children,
}: Readonly<{ eyebrow: string; title: string; intro: string; children: React.ReactNode }>) {
  return (
    <div className={styles.page}>
      <a className={styles.skipLink} href="#legal-content">Skip to main content</a>
      <header><BrandLockup /><nav aria-label="Legal page"><Link href="/">Website</Link><Link href="/login">Sign in</Link></nav></header>
      <main id="legal-content">
        <div className={styles.intro}><p>{eyebrow}</p><h1>{title}</h1><span>{intro}</span></div>
        <article>{children}</article>
      </main>
      <footer><span>Business Finlynq · AGPL-3.0-or-later</span><div><Link href="/security">Security</Link><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></div></footer>
    </div>
  );
}
