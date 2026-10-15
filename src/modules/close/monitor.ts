import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { transactionAuthMethod, type SessionPrincipal } from "@/modules/identity/session";
import type { PeriodControlWorkspaceDto } from "@/modules/ledger/tenant-workspace";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";

type Period = PeriodControlWorkspaceDto["periods"][number];
export type CloseCheck = Readonly<{
  key: string;
  label: string;
  detail: string;
  status: "BLOCKED" | "NEEDS REVIEW" | "SOURCE CHECK" | "NOT COMPUTED" | "UNKNOWN";
  href: string;
}>;
export type ClosePeriodMonitor = Readonly<{
  periodId: string;
  entityCode: string;
  ledgerCode: string;
  label: string;
  startsOn: string;
  endsOn: string;
  periodState: Period["state"];
  periodVersion: number;
  checkedAt: string;
  sourceFingerprint: string;
  checks: readonly CloseCheck[];
}>;

type Bank = { period_id: string; account_count: number; reconciled_count: number };
type Assets = { period_id: string; eligible_count: number; missing_count: number; due_depreciation: number; due_prepaid: number; drafted_count: number; posted_prepaid: number };
type OpenItems = { period_id: string; receivable_count: number; payable_count: number };
type JournalActivity = { period_id: string; posted_count: number; posted_digest: string };

function sourceRead<T>(principal: SessionPrincipal, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withWorkspaceTenantRead({
    organizationId: principal.organizationId, actorId: principal.userId,
    sessionId: principal.sessionId, sessionMode: principal.sessionMode,
    requestId: `close-monitor:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: principal.mcpConnectionId ? "MCP" : "UI",
  }, "/app/controls/period-close", work);
}

async function banks(client: PoolClient, org: string, ids: string[]): Promise<Map<string, Bank>> {
  const rows = await client.query<Bank>(`SELECT period.id AS period_id,
    (SELECT count(*)::int FROM bank_external_accounts account
     WHERE account.organization_id = period.organization_id AND account.ledger_id = period.ledger_id AND account.active) AS account_count,
    (SELECT count(*)::int FROM bank_external_accounts account
     WHERE account.organization_id = period.organization_id AND account.ledger_id = period.ledger_id AND account.active
       AND EXISTS (SELECT 1 FROM bank_reconciliation_sessions session
         WHERE session.organization_id = account.organization_id AND session.external_account_id = account.id
           AND session.status = 'FINALIZED' AND session.statement_start_on <= period.starts_on
           AND session.statement_end_on >= period.ends_on)) AS reconciled_count
    FROM fiscal_periods period WHERE period.organization_id = $1 AND period.id = ANY($2::uuid[])`, [org, ids]);
  return new Map(rows.rows.map((row) => [row.period_id, row]));
}

async function assets(client: PoolClient, org: string, ids: string[]): Promise<Map<string, Assets>> {
  const rows = await client.query<Assets>(`SELECT period.id AS period_id,
    (SELECT count(*)::int FROM asset_register a WHERE a.organization_id = period.organization_id
      AND a.ledger_id = period.ledger_id AND a.status IN ('ACTIVE', 'IMPAIRED')
      AND a.classification = 'FINITE_LIFE' AND a.in_service_on <= period.ends_on) AS eligible_count,
    (SELECT count(*)::int FROM asset_register a WHERE a.organization_id = period.organization_id
      AND a.ledger_id = period.ledger_id AND a.status IN ('ACTIVE', 'IMPAIRED')
      AND a.classification = 'FINITE_LIFE' AND a.in_service_on <= period.ends_on
      AND (a.schedule_end_on IS NULL OR a.schedule_end_on >= period.starts_on)
      AND NOT EXISTS (SELECT 1 FROM asset_schedule_entries s WHERE s.organization_id = a.organization_id
        AND s.asset_id = a.id AND s.period_end_on BETWEEN period.starts_on AND period.ends_on)) AS missing_count,
    count(s.id) FILTER (WHERE a.kind <> 'PREPAID' AND s.status = 'DUE' AND s.journal_entry_id IS NULL)::int AS due_depreciation,
    count(s.id) FILTER (WHERE a.kind = 'PREPAID' AND s.status = 'DUE' AND s.journal_entry_id IS NULL)::int AS due_prepaid,
    count(s.id) FILTER (WHERE s.status = 'DRAFTED' AND coalesce(j.status::text, '') <> 'POSTED')::int AS drafted_count,
    count(s.id) FILTER (WHERE a.kind = 'PREPAID' AND j.status = 'POSTED')::int AS posted_prepaid
    FROM fiscal_periods period
    LEFT JOIN asset_register a ON a.organization_id = period.organization_id AND a.ledger_id = period.ledger_id
    LEFT JOIN asset_schedule_entries s ON s.organization_id = a.organization_id AND s.asset_id = a.id
      AND s.period_end_on BETWEEN period.starts_on AND period.ends_on
    LEFT JOIN journal_entries j ON j.organization_id = s.organization_id AND j.id = s.journal_entry_id
    WHERE period.organization_id = $1 AND period.id = ANY($2::uuid[]) GROUP BY period.id`, [org, ids]);
  return new Map(rows.rows.map((row) => [row.period_id, row]));
}

async function openItems(client: PoolClient, org: string, ids: string[]): Promise<Map<string, OpenItems>> {
  const rows = await client.query<OpenItems>(`SELECT period.id AS period_id,
    count(item.id) FILTER (WHERE account.role = 'CUSTOMER')::int AS receivable_count,
    count(item.id) FILTER (WHERE account.role = 'SUPPLIER')::int AS payable_count
    FROM fiscal_periods period
    LEFT JOIN open_items item ON item.organization_id = period.organization_id AND item.ledger_id = period.ledger_id
      AND item.status IN ('OPEN', 'PARTIALLY_SETTLED') AND item.created_at::date <= period.ends_on
      AND (item.due_on IS NULL OR item.due_on <= period.ends_on)
    LEFT JOIN party_accounts account ON account.organization_id = item.organization_id AND account.id = item.party_account_id
    WHERE period.organization_id = $1 AND period.id = ANY($2::uuid[]) GROUP BY period.id`, [org, ids]);
  return new Map(rows.rows.map((row) => [row.period_id, row]));
}

async function journalActivity(client: PoolClient, org: string, ids: string[]): Promise<Map<string, JournalActivity>> {
  const rows = await client.query<JournalActivity>(`SELECT period.id AS period_id,
    count(journal.id)::int AS posted_count,
    encode(public.digest(coalesce(string_agg(concat_ws('|', journal.id, journal.command_hash,
      journal.content_hash, journal.accounting_date, journal.posted_at,
      journal.total_debit_functional, journal.total_credit_functional), ',' ORDER BY journal.id), ''),
      'sha256'), 'hex') AS posted_digest
    FROM fiscal_periods period
    LEFT JOIN journal_entries journal ON journal.organization_id = period.organization_id
      AND journal.period_id = period.id AND journal.status = 'POSTED'
    WHERE period.organization_id = $1 AND period.id = ANY($2::uuid[])
    GROUP BY period.id`, [org, ids]);
  return new Map(rows.rows.map((row) => [row.period_id, row]));
}

function check(key: string, label: string, detail: string, status: CloseCheck["status"], href: string): CloseCheck {
  return { key, label, detail, status, href };
}

async function trySource<T>(client: PoolClient, name: "bank" | "asset" | "items" | "journals", work: () => Promise<T>): Promise<T | undefined> {
  const savepoint = `close_monitor_${name}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await work();
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch {
    // A failed statement aborts its PostgreSQL transaction until rolled back.
    // If rollback itself fails, the outer read fails instead of showing false zeroes.
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return undefined;
  }
}

/** Independent reads keep missing or failed sources UNKNOWN instead of silently counting zero. */
export async function loadCloseMonitor(principal: SessionPrincipal, periods: readonly Period[]): Promise<readonly ClosePeriodMonitor[]> {
  const selected = periods.slice(0, 12);
  if (selected.length === 0) return [];
  const ids = selected.map((period) => period.id);
  const sources = await sourceRead(principal, async (client) => ({
    bank: await trySource(client, "bank", () => banks(client, principal.organizationId, ids)),
    asset: await trySource(client, "asset", () => assets(client, principal.organizationId, ids)),
    items: await trySource(client, "items", () => openItems(client, principal.organizationId, ids)),
    journals: await trySource(client, "journals", () => journalActivity(client, principal.organizationId, ids)),
  }));
  const checkedAt = new Date().toISOString();
  return selected.map((period) => {
    const bank = sources.bank?.get(period.id);
    const asset = sources.asset?.get(period.id);
    const items = sources.items?.get(period.id);
    const journals = sources.journals?.get(period.id);
    const checks: CloseCheck[] = [
      bank ? check("bank", "Bank reconciliation", bank.account_count === 0 ? "No active mapped bank accounts; review applicability and statement coverage." : `${bank.reconciled_count} of ${bank.account_count} active accounts have a finalized reconciliation covering the period.`, bank.account_count > 0 && bank.reconciled_count === bank.account_count ? "SOURCE CHECK" : "NEEDS REVIEW", "/app/banking")
        : check("bank", "Bank reconciliation", "Bank source could not be read. Check it before closing.", "UNKNOWN", "/app/banking"),
      items ? check("receivables", "Receivables", `${items.receivable_count} currently open customer items due by period end. Review ageing and completeness.`, "NEEDS REVIEW", "/app/receivables/invoices")
        : check("receivables", "Receivables", "Receivables source could not be read.", "UNKNOWN", "/app/receivables/invoices"),
      items ? check("payables", "Payables", `${items.payable_count} currently open supplier items due by period end. Review ageing and completeness.`, "NEEDS REVIEW", "/app/payables/bills")
        : check("payables", "Payables", "Payables source could not be read.", "UNKNOWN", "/app/payables/bills"),
      asset ? check("depreciation", "Depreciation and amortization", `${asset.due_depreciation} entries remain due without a journal; ${asset.missing_count} eligible assets lack a period schedule.`, asset.due_depreciation + asset.missing_count > 0 ? "BLOCKED" : asset.eligible_count === 0 ? "NEEDS REVIEW" : "SOURCE CHECK", "/app/assets")
        : check("depreciation", "Depreciation and amortization", "Asset source could not be read.", "UNKNOWN", "/app/assets"),
      asset ? check("prepaids", "Prepaid releases", `${asset.posted_prepaid} releases have a posted journal; ${asset.due_prepaid} remain due without one. Posted releases are not proposed again.`, asset.due_prepaid > 0 ? "BLOCKED" : asset.eligible_count === 0 ? "NEEDS REVIEW" : "SOURCE CHECK", "/app/assets")
        : check("prepaids", "Prepaid releases", "Asset source could not be read.", "UNKNOWN", "/app/assets"),
      asset ? check("asset-drafts", "Unposted asset schedules", `${asset.drafted_count} entries have a draft without a posted journal.`, asset.drafted_count > 0 ? "BLOCKED" : "SOURCE CHECK", "/app/assets")
        : check("asset-drafts", "Unposted asset schedules", "Asset source could not be read.", "UNKNOWN", "/app/assets"),
      check("unposted-journals", "Unposted journals", `${period.unpostedJournalCount} draft, submitted or approved journals remain.`, period.unpostedJournalCount > 0 ? "BLOCKED" : "SOURCE CHECK", "/app/journals"),
      check("tax-provision", "Corporate tax provision", "No reviewed period-specific provision model or sign-off is connected to this monitor.", "NOT COMPUTED", "/app/tax"),
      journals ? check("statements", "Statement review", `${journals.posted_count} posted journals in this period. Trial balance and financial statements need an explicit reviewer decision after postings are final.`, "NEEDS REVIEW", "/app/reports")
        : check("statements", "Statement review", "Posted journal activity could not be read; statement review is blocked.", "UNKNOWN", "/app/reports"),
    ];
    return {
      periodId: period.id, entityCode: period.entityCode, ledgerCode: period.ledgerCode,
      label: period.label, startsOn: period.startsOn, endsOn: period.endsOn,
      periodState: period.state, periodVersion: period.version, checkedAt,
      sourceFingerprint: createHash("sha256").update(JSON.stringify({ periodId: period.id, version: period.version, bank, asset, items, journals, unposted: period.unpostedJournalCount })).digest("hex"),
      checks,
    };
  });
}
