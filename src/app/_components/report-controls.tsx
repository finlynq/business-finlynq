import {
  reportSearchParams,
  type ReportDimensions,
  type ReportSelection,
} from "@/modules/reporting/tenant-reporting";
import styles from "./report-controls.module.css";
import { RouteTabs } from "./route-tabs";
import { ReportRangeFields } from "./report-range-fields.client";

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
    <RouteTabs label="Accounting reports" active={active} tabs={[
      { key: "all", label: "All reports", href: "/app/reports" },
      ...reports.map(([key, label, route]) => ({ key, label, href: `${route}${query ? `?${query}` : ""}` })),
    ]} />
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
      <ReportRangeFields key={`${selection.entityId}:${selection.basis}:${selection.fromDate}:${selection.toDate}`} periods={entity.periods} selection={selection} />
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
        <details className={styles.advanced} open={Boolean(selection.accountCode || Object.values(selection.segmentFilters ?? {}).some(Boolean))}>
          <summary>Account & dimension filters{selection.accountCode || Object.values(selection.segmentFilters ?? {}).some(Boolean) ? " · active" : ""}</summary>
          <div className={styles.dimensionGrid}>
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
          </div>
        </details>
      )}
      <div className={styles.actions}>
        <button className="primary-button" type="submit">Run report</button>
        {csvHref && <a className="secondary-button" href={csvHref}>Download CSV</a>}
      </div>
      <details className={styles.hint}><summary>How report ranges and dimensions work</summary><p>
        Fiscal-period mode uses the selected periods’ boundaries. Exact-date mode uses the date fields. Dimension filters accept a configured code or 0000 for an unused dimension. Reports are generated from posted journal lines in this entity’s functional currency.
      </p></details>
    </form>
  );
}
