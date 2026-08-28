import Link from "next/link";
import {
  reportSearchParams,
  type ReportDimensions,
  type ReportSelection,
} from "@/modules/reporting/tenant-reporting";
import styles from "./report-controls.module.css";

const reports = [
  ["trial-balance", "Trial balance", "/app/reports/trial-balance"],
  ["balance-sheet", "Balance sheet", "/app/reports/balance-sheet"],
  ["profit-and-loss", "Profit & loss", "/app/reports/profit-and-loss"],
  ["account-inquiry", "Account inquiry", "/app/reports/account-inquiry"],
] as const;

export type ReportKey = (typeof reports)[number][0];

export function ReportNavigation({
  active,
  selection,
}: {
  active: ReportKey;
  selection: ReportSelection | null;
}) {
  const query = selection ? reportSearchParams(selection).toString() : "";
  return (
    <nav className={styles.navigation} aria-label="Accounting reports">
      {reports.map(([key, label, route]) => (
        <Link
          aria-current={active === key ? "page" : undefined}
          href={`${route}${query ? `?${query}` : ""}`}
          key={key}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function ReportFilters({
  action,
  dimensions,
  selection,
  showAccount = false,
  showDimensions = false,
  csvHref,
}: {
  action: string;
  dimensions: ReportDimensions;
  selection: ReportSelection;
  showAccount?: boolean;
  showDimensions?: boolean;
  csvHref?: string;
}) {
  const entity = dimensions.entities.find((candidate) => candidate.id === selection.entityId)
    ?? dimensions.entities[0];
  if (!entity) return null;
  return (
    <form className={styles.filters} action={action} method="get">
      <label>
        <span>Legal entity</span>
        <select name="entity" defaultValue={selection.entityId}>
          {dimensions.entities.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.code} · {candidate.displayName} · {candidate.currency}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Range basis</span>
        <select name="basis" defaultValue={selection.basis}>
          <option value="period">Fiscal periods</option>
          <option value="date">Exact dates</option>
        </select>
      </label>
      <label>
        <span>From period</span>
        <select name="fromPeriod" defaultValue={selection.fromPeriodId ?? ""}>
          <option value="">No period</option>
          {entity.periods.map((period) => <option key={period.id} value={period.id}>{period.label}</option>)}
        </select>
      </label>
      <label>
        <span>To period</span>
        <select name="toPeriod" defaultValue={selection.toPeriodId ?? ""}>
          <option value="">No period</option>
          {entity.periods.map((period) => <option key={period.id} value={period.id}>{period.label}</option>)}
        </select>
      </label>
      <label>
        <span>From date</span>
        <input name="from" type="date" defaultValue={selection.fromDate} />
      </label>
      <label>
        <span>To date</span>
        <input name="to" type="date" defaultValue={selection.toDate} />
      </label>
      {showAccount && (
        <label className={styles.account}>
          <span>GL account</span>
          <select name="account" defaultValue={selection.accountId ?? ""}>
            {entity.accounts.length === 0 && <option value="">No active accounts</option>}
            {entity.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {account.displayName} · {account.accountClass}
              </option>
            ))}
          </select>
        </label>
      )}
      {showDimensions && (
        <>
          <label className={styles.dimension}>
            <span>Natural account</span>
            <select name="accountCode" defaultValue={selection.accountCode ?? ""}>
              <option value="">All accounts</option>
              {entity.accounts.map((account) => (
                <option key={account.id} value={account.code}>
                  {account.code} · {account.displayName}
                </option>
              ))}
            </select>
          </label>
          {(dimensions.segments ?? []).map((segment) => (
            <label className={styles.dimension} key={segment.key}>
              <span>{segment.displayName}</span>
              <input
                name={`segment_${segment.key}`}
                defaultValue={selection.segmentFilters?.[segment.key] ?? ""}
                pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,15}"
                maxLength={16}
                placeholder="All codes"
              />
            </label>
          ))}
        </>
      )}
      <div className={styles.actions}>
        <button className="primary-button" type="submit">Run report</button>
        {csvHref && <a className="secondary-button" href={csvHref}>Download CSV</a>}
      </div>
      <p className={styles.hint}>
        Fiscal-period mode uses the selected periods’ boundaries. Exact-date mode uses the date fields. Dimension filters accept a configured code or 0000 for an unused dimension. Reports are generated from posted journal lines in this entity’s functional currency.
      </p>
    </form>
  );
}
