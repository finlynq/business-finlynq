import styles from "../marketing.module.css";

const metrics = [
  ["Cash", "USD 284,620", "+4.8%"],
  ["Receivables", "USD 96,410", "12 open"],
  ["Payables", "CAD 58,760", "8 due"],
] as const;

export function ProductPreview() {
  return (
    <div className={styles.previewShell} role="img" aria-label="Business Finlynq read-only accounting dashboard preview showing multicurrency balances, recent journals, and period-close status">
      <div className={styles.previewTopbar} aria-hidden="true">
        <span><i aria-hidden="true" /> Public synthetic demo</span>
        <span>August 2026</span>
      </div>
      <div className={styles.previewBody} aria-hidden="true">
        <aside className={styles.previewRail} aria-hidden="true">
          <b>F</b><span className={styles.activeRail}>OV</span><span>GL</span><span>AR</span><span>AP</span><span>TX</span>
        </aside>
        <div className={styles.previewContent}>
          <div className={styles.previewHeading}>
            <div><small>Northstar Demo Group</small><strong>Accounting overview</strong></div>
            <span>Read only</span>
          </div>
          <div className={styles.previewMetrics}>
            {metrics.map(([label, value, note]) => (
              <div key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>
            ))}
          </div>
          <div className={styles.previewGrid}>
            <div className={styles.previewPanel}>
              <div className={styles.previewPanelTitle}><strong>Recent journals</strong><span>View all</span></div>
              <div className={styles.previewRows}>
                <p><b>JE-1048</b><span>Accounts payable</span><strong>12,480.00</strong></p>
                <p><b>JE-1047</b><span>Receivables</span><strong>8,920.00</strong></p>
                <p><b>JE-1046</b><span>Manual accrual</span><strong>4,250.00</strong></p>
              </div>
            </div>
            <div className={`${styles.previewPanel} ${styles.closePanel}`}>
              <div className={styles.previewPanelTitle}><strong>Period close</strong><em>2 blockers</em></div>
              <div className={styles.closeProgress}><span style={{ width: "72%" }} /></div>
              <p>Evidence collected</p><p>Tax decisions <b>2 open</b></p><p>Bank reconciliation <b>Ready</b></p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
