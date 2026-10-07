import Link from "next/link";
import {
  journalFilterHref,
  journalFilterStatuses,
  type JournalFilterState,
  type JournalFilterOptions,
  type JournalFilterValues,
} from "@/modules/ledger/journal-register-filters";
import styles from "./journal-register-filters.module.css";

const fieldLabels: Record<Exclude<keyof JournalFilterValues, "status">, string> = {
  dateFrom: "From", dateTo: "To", fiscalYear: "Fiscal year", periodId: "Period", accountId: "Natural account",
  typeKey: "Journal type", ownerModule: "Source module", minAmount: "Minimum total", maxAmount: "Maximum total", currency: "Currency",
};

export function JournalRegisterFilters({ search, state, options }: Readonly<{
  search: string;
  state: JournalFilterState;
  options: JournalFilterOptions;
}>) {
  const { values, errors } = state;
  const href = journalFilterHref(values, search);
  const active = Object.entries(fieldLabels).flatMap(([key, label]) => {
    const field = key as Exclude<keyof JournalFilterValues, "status">;
    const value = values[field];
    if (!value) return [];
    const display = field === "accountId" ? options.accounts.find((account) => account.id === value)?.label
      : field === "periodId" ? options.periods.find((period) => period.id === value)?.label
      : field === "typeKey" ? options.journalTypes.find((type) => type.key === value)?.label : value;
    return [{ field, label: `${label}: ${display ?? value}` }];
  });
  const hasFilters = Boolean(search || active.length || values.status.length);
  return (
    <section className={styles.filters} aria-label="Journal filters">
      <form key={href} action="/app/journals" method="get" aria-label="Filter journal register" className={styles.form}>
        <label className={styles.search}><span>Journal, description, entity, or type</span><input type="search" name="q" defaultValue={search} maxLength={100} /></label>
        <label><span>Accounting date from</span><input type="date" name="dateFrom" defaultValue={values.dateFrom} /></label>
        <label><span>Accounting date to</span><input type="date" name="dateTo" defaultValue={values.dateTo} /></label>
        <label><span>Fiscal year</span><select name="fiscalYear" defaultValue={values.fiscalYear}><option value="">All fiscal years</option>{options.fiscalYears.map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
        <label><span>Accounting period</span><select name="periodId" defaultValue={values.periodId}><option value="">All periods</option>{options.periods.map((period) => <option key={period.id} value={period.id}>{period.label} ({period.startsOn} – {period.endsOn})</option>)}</select></label>
        <fieldset className={styles.statuses}><legend>Journal status</legend>{journalFilterStatuses.map((status) => <label key={status}><input type="checkbox" name="status" value={status} defaultChecked={values.status.includes(status)} /><span>{status.charAt(0) + status.slice(1).toLowerCase()}</span></label>)}</fieldset>
        <label><span>Natural account on any line</span><select name="accountId" defaultValue={values.accountId}><option value="">All natural accounts</option>{options.accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label>
        <label><span>Journal type</span><select name="typeKey" defaultValue={values.typeKey}><option value="">All journal types</option>{options.journalTypes.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}</select></label>
        <label><span>Source module</span><select name="ownerModule" defaultValue={values.ownerModule}><option value="">All source modules</option>{options.sourceModules.map((module) => <option key={module} value={module}>{module}</option>)}</select></label>
        <fieldset className={styles.amounts}><legend>Functional-currency journal total (debit)</legend>
          <label><span>Minimum total</span><input type="text" inputMode="decimal" name="minAmount" defaultValue={values.minAmount} maxLength={39} placeholder="0.00" /></label>
          <label><span>Maximum total</span><input type="text" inputMode="decimal" name="maxAmount" defaultValue={values.maxAmount} maxLength={39} placeholder="No maximum" /></label>
          <label><span>Functional currency</span><select name="currency" defaultValue={values.currency}><option value="">All currencies</option>{options.currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}</select></label>
          <p className={styles.basis}>Amounts use each journal’s functional currency without conversion. Choose a currency to compare the same unit.</p>
        </fieldset>
        <div className={styles.controls}><button className="secondary-button" type="submit">Apply filters</button>{hasFilters && <Link className="text-link compact-button" href="/app/journals">Clear all</Link>}</div>
      </form>
      {errors.length > 0 && <div role="alert" className={styles.errors}><strong>Check your filters</strong><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
      {hasFilters && <div className={styles.active} aria-label="Active journal filters">
        <span>Active filters:</span>
        {search && <Link className={styles.chip} href={journalFilterHref(values, search, "q")} aria-label={`Remove search: ${search}`}>Search: {search} ×</Link>}
        {active.map(({ field, label }) => <Link className={styles.chip} key={field} href={journalFilterHref(values, search, field)} aria-label={`Remove ${label}`}>{label} ×</Link>)}
        {values.status.map((status) => <Link className={styles.chip} key={status} href={journalFilterHref(values, search, "status", status)} aria-label={`Remove status: ${status}`}>Status: {status} ×</Link>)}
      </div>}
    </section>
  );
}
