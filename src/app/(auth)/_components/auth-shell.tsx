import Link from "next/link";
import { BrandLockup } from "@/app/_components/brand-lockup";
import styles from "../auth.module.css";

export function AuthShell({
  eyebrow,
  title,
  description,
  children,
}: Readonly<{
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}>) {
  return (
    <main className={styles.authPage}>
      <a className={styles.skipLink} href="#auth-form">Skip to form</a>
      <section className={styles.brandPanel} aria-label="Business Finlynq">
        <BrandLockup href="/" inverse />
        <div>
          <p>Accounting with an audit trail</p>
          <div className={styles.brandStatement}>Control the close.<br />Preserve the story.</div>
          <ul>
            <li>Immutable posted history</li>
            <li>Entity and role boundaries</li>
            <li>Multicurrency provenance</li>
          </ul>
        </div>
        <p className={styles.brandFootnote}>Open source · AGPL-3.0-or-later</p>
      </section>
      <section className={styles.formPanel}>
        <div className={styles.mobileBrand}><BrandLockup href="/" /></div>
        <div className={styles.formCard}>
          <Link className={styles.backLink} href="/"><span aria-hidden="true">←</span> Back to website</Link>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1>{title}</h1>
          <p className={styles.description}>{description}</p>
          <div id="auth-form">{children}</div>
        </div>
      </section>
    </main>
  );
}
