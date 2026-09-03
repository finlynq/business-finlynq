import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { TenantTransactionContext } from "@/db/transaction";
import { demoAccountingDate } from "@/modules/demo/accounting-clock";
import {
  hasRecentStepUp,
  transactionAuthMethod,
  type SessionPrincipal,
} from "@/modules/identity/session";
import { actorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  createBlindIndex,
  decryptField,
  parseEncryptedField,
} from "@/security/organization-encryption";
import { loadActiveOrganizationKey } from "@/security/organization-key-store";
import { principalCanWrite } from "@/modules/workspace/write-policy";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";
import {
  normalizeRegisterPage,
  registerPageSize,
  registerPageWindow,
  type RegisterPagination,
} from "@/modules/workspace/register-pagination";
import {
  presentAccountKey,
  type DisplayedAccountSegment,
} from "./account-key-display";

export type TenantReadiness = "EMPTY_ORGANIZATION" | "ENCRYPTION_SETUP_REQUIRED" | "READY";

export type TenantJournalDto = Readonly<{
  id: string;
  ledgerId: string;
  number: string;
  accountingDate: string;
  entityCode: string;
  currency: string;
  description: string;
  typeKey: string;
  typeLabel: string;
  ownerModule: string;
  correctionRoute: string;
  status: string;
  amount: string;
  debitFunctional: string;
  creditFunctional: string;
  sourceNumber: string | null;
  expectedContentHash: string | null;
  reversalOfNumber: string | null;
  reversedByNumber: string | null;
  accountKeys: readonly Readonly<{
    canonicalKey: string;
    displayKey: string;
    displaySegments: readonly DisplayedAccountSegment[];
  }>[];
  accountPostings: readonly Readonly<{
    canonicalKey: string;
    displayKey: string;
    displaySegments: readonly DisplayedAccountSegment[];
    debitFunctional: string;
    creditFunctional: string;
    endingBalanceFunctional: string;
    endingSide: "DEBIT" | "CREDIT" | "ZERO";
  }>[];
  canPost: boolean;
  canReverse: boolean;
}>;

export type TenantJournalDetailDto = Readonly<{
  id: string;
  number: string;
  accountingDate: string;
  entityCode: string;
  ledgerCode: string;
  functionalCurrency: string;
  description: string;
  typeKey: string;
  typeLabel: string;
  ownerModule: string;
  origin: string;
  purpose: string;
  status: string;
  sourceNumber: string | null;
  sourceHref: string | null;
  debitFunctional: string;
  creditFunctional: string;
  postedAt: string | null;
  lines: readonly Readonly<{
    id: string;
    lineNumber: number;
    accountCode: string;
    accountName: string;
    canonicalKey: string;
    displayKey: string;
    displaySegments: readonly DisplayedAccountSegment[];
    memo: string | null;
    transactionCurrency: string;
    debitTransaction: string;
    creditTransaction: string;
    fxRate: string;
    fxRateSource: string;
    fxRateEffectiveAt: string;
    debitFunctional: string;
    creditFunctional: string;
  }>[];
}>;

export type TenantJournalReversalPeriodDto = Readonly<{
  id: string;
  ledgerId: string;
  entityCode: string;
  label: string;
  startsOn: string;
  endsOn: string;
  state: "OPEN" | "ADJUSTMENT_ONLY";
  defaultAccountingDate: string;
}>;

export type TenantJournalWorkspaceDto = Readonly<{
  demoOnly: boolean;
  readiness: TenantReadiness;
  canDraft: boolean;
  canPost: boolean;
  canReverse: boolean;
  reversalPeriods: readonly TenantJournalReversalPeriodDto[];
  journals: readonly TenantJournalDto[];
  pagination: RegisterPagination;
}>;

export type TenantPartyDirectoryDto = Readonly<{
  demoOnly: boolean;
  readiness: TenantReadiness;
  canManage: boolean;
  parties: readonly TenantPartyDto[];
  pagination: RegisterPagination;
}>;

export type TenantPartyDto = Readonly<{
  id: string;
  partyNumber: string;
  displayName: string;
  active: boolean;
  accounts: readonly TenantPartyAccountDto[];
  addresses: readonly TenantPartyAddressDto[];
}>;

export type TenantPartyAccountDto = Readonly<{
  id: string;
  legalEntityId: string;
  entityCode: string;
  entityName: string;
  ledgerCode: string;
  role: "CUSTOMER" | "SUPPLIER";
  accountNumber: string;
  transactionCurrency: string | null;
  controlAccountCode: string;
  active: boolean;
}>;

export type TenantPartyAddressDto = Readonly<{
  id: string;
  kind: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  validFrom: string;
  validTo: string | null;
}>;

const partyAddressPayloadSchema = z.object({
  line1: z.string(),
  line2: z.string().optional(),
  city: z.string(),
  region: z.string(),
  postalCode: z.string(),
  countryCode: z.string(),
});

export type ManualJournalOptionsDto = Readonly<{
  readOnly: boolean;
  entities: readonly Readonly<{
    id: string;
    code: string;
    ledgerId: string;
    currency: string;
    periods: readonly Readonly<{
      id: string;
      label: string;
      startsOn: string;
      endsOn: string;
      state: "OPEN" | "ADJUSTMENT_ONLY";
    }>[];
    accounts: readonly Readonly<{
      combinationId: string;
      code: string;
      displayName: string;
    }>[];
  }>[];
}>;

export type PeriodControlWorkspaceDto = Readonly<{
  demoOnly: boolean;
  canCreate: boolean;
  canClose: boolean;
  canReopen: boolean;
  canSeal: boolean;
  recentStepUp: boolean;
  ledgers: readonly Readonly<{
    id: string;
    entityCode: string;
    ledgerCode: string;
    currency: string;
  }>[];
  periods: readonly Readonly<{
    id: string;
    ledgerId: string;
    entityCode: string;
    ledgerCode: string;
    currency: string;
    label: string;
    startsOn: string;
    endsOn: string;
    state: "OPEN" | "ADJUSTMENT_ONLY" | "HARD_CLOSED" | "SEALED";
    version: number;
    unpostedJournalCount: number;
  }>[];
}>;

function readContext(principal: SessionPrincipal): TenantTransactionContext {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId: `read:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "UI",
  };
}

async function assertActiveSessionMembership(
  client: PoolClient,
  principal: SessionPrincipal,
): Promise<Readonly<{ isDemo: boolean }>> {
  const result = await client.query<{ is_demo: boolean }>(
    `SELECT organization.is_demo
     FROM organization_memberships membership
     JOIN organizations organization
       ON organization.id = membership.organization_id
     WHERE membership.organization_id = $1
       AND membership.id = $2
       AND membership.user_id = $3
       AND membership.active AND organization.active`,
    [principal.organizationId, principal.membershipId, principal.userId],
  );
  if (!result.rows[0]) throw new Error("The session no longer has an active organization membership");
  return { isDemo: result.rows[0].is_demo };
}

async function tenantReadiness(client: PoolClient, organizationId: string): Promise<TenantReadiness> {
  const result = await client.query<{
    entity_count: number;
    ledger_count: number;
    active_key_count: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM legal_entities WHERE organization_id = $1 AND active) AS entity_count,
       (SELECT count(*)::int FROM ledgers WHERE organization_id = $1 AND active) AS ledger_count,
       (SELECT count(*)::int FROM organization_key_versions WHERE organization_id = $1 AND active) AS active_key_count`,
    [organizationId],
  );
  const counts = result.rows[0];
  if (!counts || counts.entity_count === 0 || counts.ledger_count === 0) return "EMPTY_ORGANIZATION";
  if (counts.active_key_count !== 1) return "ENCRYPTION_SETUP_REQUIRED";
  return "READY";
}

function trustedSourceHref(
  ownerModule: string,
  correctionRoute: string,
  sourceNumber: string | null,
): string | null {
  const expectedBase = ownerModule === "receivables"
    ? "/app/receivables/invoices"
    : ownerModule === "payables" ? "/app/payables/bills" : null;
  if (!expectedBase) return null;
  const base = correctionRoute === expectedBase ? correctionRoute : expectedBase;
  return sourceNumber ? `${base}?q=${encodeURIComponent(sourceNumber)}` : base;
}

export async function loadTenantJournalWorkspace(
  principal: SessionPrincipal,
  search = "",
  selectedEntityId: string | null = null,
  requestedPage = 1,
): Promise<TenantJournalWorkspaceDto> {
  const normalizedSearch = search.trim().slice(0, 100);
  const page = normalizeRegisterPage(requestedPage);
  return withWorkspaceTenantRead(readContext(principal), "/app/journals", async (client) => {
    const membership = await assertActiveSessionMembership(client, principal);
    const canReadLedger = await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readMcpLedger,
    });
    if (!canReadLedger) throw new Error("Ledger read permission is required");
    const readiness = await tenantReadiness(client, principal.organizationId);
    const pattern = `%${normalizedSearch.replace(/[\\%_]/g, "\\$&")}%`;
    const journals = await client.query<{
      id: string;
      ledger_id: string;
      journal_number: number | null;
      accounting_date: string;
      entity_code: string;
      functional_currency: string;
      description: string;
      journal_type_key: string;
      type_label: string;
      owner_module: string;
      correction_route: string;
      status: string;
      period_state: "OPEN" | "ADJUSTMENT_ONLY" | "HARD_CLOSED" | "SEALED";
      total_debit_functional: string;
      total_credit_functional: string | undefined;
      source_number: string | null;
      canonical_account_keys: string[] | null;
      account_segment_definitions: unknown;
      canonical_content_hash: string | null;
      reversal_of_number: number | null;
      reversed_by_number: number | null;
    }>(
      `SELECT entry.id, entry.ledger_id, entry.journal_number, entry.accounting_date::text,
         entity.code AS entity_code, entry.functional_currency, entry.description,
         entry.journal_type_key, journal_type.display_name AS type_label,
         journal_type.owner_module, journal_type.correction_route, entry.status,
         entry_period.state AS period_state,
         CASE WHEN entry.status = 'POSTED' THEN entry.total_debit_functional
              ELSE coalesce((SELECT sum(line.debit_functional)
                             FROM journal_lines line
                             WHERE line.organization_id = entry.organization_id
                               AND line.journal_entry_id = entry.id), 0)
         END::text AS total_debit_functional,
         CASE WHEN entry.status = 'POSTED' THEN entry.total_credit_functional
              ELSE coalesce((SELECT sum(line.credit_functional)
                             FROM journal_lines line
                             WHERE line.organization_id = entry.organization_id
                               AND line.journal_entry_id = entry.id), 0)
         END::text AS total_credit_functional,
         source.source_number,
         line_accounts.canonical_account_keys,
         (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'key', definition.key,
              'displayName', definition.display_name,
              'visible', definition.visible
            ) ORDER BY definition.ordinal), '[]'::jsonb)
          FROM segment_definitions definition
          WHERE definition.organization_id = entry.organization_id
         ) AS account_segment_definitions,
         CASE WHEN entry.status = 'DRAFT'
                    AND entry.journal_type_key = 'ledger.manual'
                    AND journal_type.owner_module = 'ledger'
              THEN app.compute_journal_content_hash(entry.id)::text
              ELSE NULL
         END AS canonical_content_hash,
         reversed.journal_number AS reversal_of_number,
         reversed_by.journal_number AS reversed_by_number
       FROM journal_entries entry
       JOIN legal_entities entity
         ON entity.organization_id = entry.organization_id AND entity.id = entry.legal_entity_id
       JOIN fiscal_periods entry_period
         ON entry_period.organization_id = entry.organization_id
        AND entry_period.ledger_id = entry.ledger_id
        AND entry_period.id = entry.period_id
       JOIN journal_type_definitions journal_type
         ON journal_type.id = entry.journal_type_definition_id
        AND journal_type.key = entry.journal_type_key
        AND journal_type.version = entry.journal_type_version
       LEFT JOIN source_documents source
         ON source.organization_id = entry.organization_id
        AND source.id = entry.source_document_id
       LEFT JOIN LATERAL (
         SELECT array_agg(account_key.canonical_key ORDER BY account_key.canonical_key)
           AS canonical_account_keys
         FROM (
           SELECT DISTINCT concat_ws('.', line_entity.code, line_account.code,
             coalesce(subaccount.code, '0000'), coalesce(department.code, '0000'),
             coalesce(intercompany.code, '0000'),
             coalesce(custom1.code, '0000'), coalesce(custom2.code, '0000'),
             coalesce(custom3.code, '0000'), coalesce(custom4.code, '0000'),
             coalesce(custom5.code, '0000'), coalesce(custom6.code, '0000'),
             coalesce(custom7.code, '0000'), coalesce(custom8.code, '0000')) AS canonical_key
           FROM journal_lines line
           JOIN account_combinations combination
             ON combination.organization_id = line.organization_id
            AND combination.id = line.account_combination_id
           JOIN legal_entities line_entity
             ON line_entity.organization_id = combination.organization_id
            AND line_entity.id = combination.entity_id
           JOIN gl_accounts line_account
             ON line_account.organization_id = combination.organization_id
            AND line_account.id = combination.account_id
           LEFT JOIN segment_values subaccount ON subaccount.organization_id = combination.organization_id AND subaccount.id = combination.subaccount_id
           LEFT JOIN segment_values department ON department.organization_id = combination.organization_id AND department.id = combination.department_id
           LEFT JOIN legal_entities intercompany ON intercompany.organization_id = combination.organization_id AND intercompany.id = combination.intercompany_entity_id
           LEFT JOIN segment_values custom1 ON custom1.organization_id = combination.organization_id AND custom1.id = combination.custom_1_id
           LEFT JOIN segment_values custom2 ON custom2.organization_id = combination.organization_id AND custom2.id = combination.custom_2_id
           LEFT JOIN segment_values custom3 ON custom3.organization_id = combination.organization_id AND custom3.id = combination.custom_3_id
           LEFT JOIN segment_values custom4 ON custom4.organization_id = combination.organization_id AND custom4.id = combination.custom_4_id
           LEFT JOIN segment_values custom5 ON custom5.organization_id = combination.organization_id AND custom5.id = combination.custom_5_id
           LEFT JOIN segment_values custom6 ON custom6.organization_id = combination.organization_id AND custom6.id = combination.custom_6_id
           LEFT JOIN segment_values custom7 ON custom7.organization_id = combination.organization_id AND custom7.id = combination.custom_7_id
           LEFT JOIN segment_values custom8 ON custom8.organization_id = combination.organization_id AND custom8.id = combination.custom_8_id
           WHERE line.organization_id = entry.organization_id
             AND line.journal_entry_id = entry.id
         ) account_key
       ) line_accounts ON true
       LEFT JOIN LATERAL (
         SELECT original.journal_number
         FROM journal_entry_relations relation
         JOIN journal_entries original
           ON original.organization_id = relation.organization_id
          AND original.id = relation.to_journal_id
         WHERE relation.organization_id = entry.organization_id
           AND relation.from_journal_id = entry.id
           AND relation.kind = 'REVERSAL_OF'
         LIMIT 1
       ) reversed ON true
       LEFT JOIN LATERAL (
         SELECT reversal.journal_number
         FROM journal_entry_relations relation
         JOIN journal_entries reversal
           ON reversal.organization_id = relation.organization_id
          AND reversal.id = relation.from_journal_id
         WHERE relation.organization_id = entry.organization_id
           AND relation.to_journal_id = entry.id
           AND relation.kind = 'REVERSAL_OF'
         ORDER BY reversal.created_at DESC, reversal.id DESC
         LIMIT 1
       ) reversed_by ON true
       WHERE entry.organization_id = $1
         AND ($4::uuid IS NULL OR entry.legal_entity_id = $4::uuid)
         AND ($2 = '' OR entry.description ILIKE $3 ESCAPE '\\'
              OR entry.journal_type_key ILIKE $3 ESCAPE '\\'
              OR entity.code ILIKE $3 ESCAPE '\\'
              OR coalesce(entry.journal_number::text, 'draft') ILIKE $3 ESCAPE '\\')
       ORDER BY entry.accounting_date DESC, entry.created_at DESC, entry.id DESC
       LIMIT $5 OFFSET $6`,
      [
        principal.organizationId,
        normalizedSearch,
        pattern,
        selectedEntityId,
        registerPageSize + 1,
        (page - 1) * registerPageSize,
      ],
    );
    const journalPage = registerPageWindow(journals.rows, page);
    const journalIds = journalPage.rows.map((row) => row.id);
    const accountPostingRows = journalIds.length > 0
      ? await client.query<{
          journal_entry_id: string;
          canonical_key: string;
          debit_functional: string;
          credit_functional: string;
          ending_balance_functional: string;
          ending_side: "DEBIT" | "CREDIT" | "ZERO";
        }>(
          `WITH current_postings AS (
             SELECT line.journal_entry_id,
               combination.id AS account_combination_id,
               concat_ws('.', entity.code, account.code,
                 coalesce(subaccount.code, '0000'), coalesce(department.code, '0000'),
                 coalesce(intercompany.code, '0000'),
                 coalesce(custom1.code, '0000'), coalesce(custom2.code, '0000'),
                 coalesce(custom3.code, '0000'), coalesce(custom4.code, '0000'),
                 coalesce(custom5.code, '0000'), coalesce(custom6.code, '0000'),
                 coalesce(custom7.code, '0000'), coalesce(custom8.code, '0000')) AS canonical_key,
               sum(line.debit_functional)::text AS debit_functional,
               sum(line.credit_functional)::text AS credit_functional
             FROM journal_lines line
             JOIN account_combinations combination
               ON combination.organization_id = line.organization_id
              AND combination.id = line.account_combination_id
             JOIN legal_entities entity
               ON entity.organization_id = combination.organization_id
              AND entity.id = combination.entity_id
             JOIN gl_accounts account
               ON account.organization_id = combination.organization_id
              AND account.id = combination.account_id
             LEFT JOIN segment_values subaccount ON subaccount.organization_id = combination.organization_id AND subaccount.id = combination.subaccount_id
             LEFT JOIN segment_values department ON department.organization_id = combination.organization_id AND department.id = combination.department_id
             LEFT JOIN legal_entities intercompany ON intercompany.organization_id = combination.organization_id AND intercompany.id = combination.intercompany_entity_id
             LEFT JOIN segment_values custom1 ON custom1.organization_id = combination.organization_id AND custom1.id = combination.custom_1_id
             LEFT JOIN segment_values custom2 ON custom2.organization_id = combination.organization_id AND custom2.id = combination.custom_2_id
             LEFT JOIN segment_values custom3 ON custom3.organization_id = combination.organization_id AND custom3.id = combination.custom_3_id
             LEFT JOIN segment_values custom4 ON custom4.organization_id = combination.organization_id AND custom4.id = combination.custom_4_id
             LEFT JOIN segment_values custom5 ON custom5.organization_id = combination.organization_id AND custom5.id = combination.custom_5_id
             LEFT JOIN segment_values custom6 ON custom6.organization_id = combination.organization_id AND custom6.id = combination.custom_6_id
             LEFT JOIN segment_values custom7 ON custom7.organization_id = combination.organization_id AND custom7.id = combination.custom_7_id
             LEFT JOIN segment_values custom8 ON custom8.organization_id = combination.organization_id AND custom8.id = combination.custom_8_id
             WHERE line.organization_id = $1
               AND line.journal_entry_id = ANY($2::uuid[])
             GROUP BY line.journal_entry_id, combination.id,
               entity.code, account.code, subaccount.code, department.code,
               intercompany.code, custom1.code, custom2.code, custom3.code,
               custom4.code, custom5.code, custom6.code, custom7.code, custom8.code
           )
           SELECT posting.journal_entry_id, posting.canonical_key,
             posting.debit_functional, posting.credit_functional,
             CASE WHEN account_balance.net_functional > 0 THEN 'DEBIT'
                  WHEN account_balance.net_functional < 0 THEN 'CREDIT'
                  ELSE 'ZERO' END AS ending_side,
             abs(account_balance.net_functional)::text AS ending_balance_functional
           FROM current_postings posting
           JOIN journal_entries current_entry
             ON current_entry.organization_id = $1
            AND current_entry.id = posting.journal_entry_id
           LEFT JOIN LATERAL (
               SELECT coalesce(sum(
                 history_line.debit_functional - history_line.credit_functional
               ), 0) AS net_functional
               FROM journal_lines history_line
               JOIN journal_entries history_entry
                 ON history_entry.organization_id = history_line.organization_id
                AND history_entry.id = history_line.journal_entry_id
               WHERE history_line.organization_id = $1
                 AND history_line.account_combination_id = posting.account_combination_id
                 AND history_entry.status = 'POSTED'
                 AND history_entry.accounting_date <= current_entry.accounting_date
           ) account_balance ON true
           ORDER BY posting.journal_entry_id, posting.canonical_key`,
          [principal.organizationId, journalIds],
        )
      : { rows: [] };
    const postingsByJournal = new Map<string, typeof accountPostingRows.rows>();
    for (const posting of accountPostingRows.rows) {
      const existing = postingsByJournal.get(posting.journal_entry_id) ?? [];
      existing.push(posting);
      postingsByJournal.set(posting.journal_entry_id, existing);
    }
    const writable = principalCanWrite(principal);
    const canDraft = writable && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.draftJournal,
    });
    const canPost = writable && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.postJournal,
    });
    const canReverse = writable && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.reverseJournal,
    });
    const canPostAdjustment = writable && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.postAdjustment,
    });
    const today = principal.sessionMode === "demo"
      ? demoAccountingDate()
      : new Date().toISOString().slice(0, 10);
    const reversalPeriodRows = canPost && canReverse
      ? await client.query<{
          id: string;
          ledger_id: string;
          entity_code: string;
          label: string;
          starts_on: string;
          ends_on: string;
          state: "OPEN" | "ADJUSTMENT_ONLY";
        }>(
          `SELECT period.id, period.ledger_id, entity.code AS entity_code,
             period.label, period.starts_on::text, period.ends_on::text, period.state
           FROM fiscal_periods period
           JOIN ledgers ledger
             ON ledger.organization_id = period.organization_id
            AND ledger.id = period.ledger_id AND ledger.active
           JOIN legal_entities entity
             ON entity.organization_id = ledger.organization_id
            AND entity.id = ledger.legal_entity_id AND entity.active
           WHERE period.organization_id = $1
             AND (period.state = 'OPEN' OR ($2::boolean AND period.state = 'ADJUSTMENT_ONLY'))
           ORDER BY CASE WHEN $3::date BETWEEN period.starts_on AND period.ends_on THEN 0 ELSE 1 END,
             period.starts_on DESC, entity.code`,
          [principal.organizationId, canPostAdjustment, today],
        )
      : { rows: [] };
    const reversalPeriods: TenantJournalReversalPeriodDto[] = reversalPeriodRows.rows.map((period) => ({
      id: period.id,
      ledgerId: period.ledger_id,
      entityCode: period.entity_code,
      label: period.label,
      startsOn: period.starts_on,
      endsOn: period.ends_on,
      state: period.state,
      defaultAccountingDate: today < period.starts_on
        ? period.starts_on
        : today > period.ends_on ? period.ends_on : today,
    }));
    const contentHashPattern = /^[a-f0-9]{64}$/i;
    return {
      demoOnly: membership.isDemo,
      readiness,
      canDraft,
      canPost,
      canReverse: canPost && canReverse,
      reversalPeriods,
      pagination: journalPage.pagination,
      journals: journalPage.rows.map((row) => {
        const accountPostings = (postingsByJournal.get(row.id) ?? []).map((posting) => ({
          ...presentAccountKey(posting.canonical_key, row.account_segment_definitions),
          debitFunctional: posting.debit_functional,
          creditFunctional: posting.credit_functional,
          endingBalanceFunctional: posting.ending_balance_functional,
          endingSide: posting.ending_side,
        }));
        return {
          id: row.id,
          ledgerId: row.ledger_id,
          number: row.journal_number === null ? "Draft" : String(row.journal_number),
          accountingDate: row.accounting_date,
          entityCode: row.entity_code,
          currency: row.functional_currency,
          description: row.description,
          typeKey: row.journal_type_key,
          typeLabel: row.type_label,
          ownerModule: row.owner_module,
          correctionRoute: row.correction_route,
          status: row.status,
          amount: row.total_debit_functional,
          debitFunctional: row.total_debit_functional,
          creditFunctional: row.total_credit_functional ?? row.total_debit_functional,
          sourceNumber: row.source_number,
          expectedContentHash: row.canonical_content_hash,
          reversalOfNumber: row.reversal_of_number === null ? null : String(row.reversal_of_number),
          reversedByNumber: row.reversed_by_number === null ? null : String(row.reversed_by_number),
          accountKeys: (row.canonical_account_keys ?? []).map((canonicalKey) => (
            presentAccountKey(canonicalKey, row.account_segment_definitions)
          )),
          accountPostings,
          canPost: canPost && row.owner_module === "ledger" && row.journal_type_key === "ledger.manual" &&
            row.status === "DRAFT" && (row.period_state === "OPEN" ||
              (row.period_state === "ADJUSTMENT_ONLY" && canPostAdjustment)) &&
            contentHashPattern.test(row.canonical_content_hash ?? ""),
          canReverse: canPost && canReverse && row.owner_module === "ledger" &&
            row.journal_type_key === "ledger.manual" && row.status === "POSTED" &&
            row.reversed_by_number === null && reversalPeriods.some((period) => period.ledgerId === row.ledger_id),
        };
      }),
    };
  });
}

export async function loadTenantJournalDetail(
  principal: SessionPrincipal,
  journalId: string,
): Promise<TenantJournalDetailDto | null> {
  return withWorkspaceTenantRead(readContext(principal), `/app/journals/${journalId}`, async (client) => {
    await assertActiveSessionMembership(client, principal);
    const canReadLedger = await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readMcpLedger,
    });
    if (!canReadLedger) throw new Error("Ledger read permission is required");

    const headerResult = await client.query<{
      id: string;
      journal_number: number | null;
      accounting_date: string;
      entity_code: string;
      ledger_code: string;
      functional_currency: string;
      description: string;
      journal_type_key: string;
      type_label: string;
      owner_module: string;
      correction_route: string;
      origin: string;
      purpose: string;
      status: string;
      source_number: string | null;
      total_debit_functional: string;
      total_credit_functional: string;
      posted_at: string | null;
    }>(
      `SELECT entry.id, entry.journal_number, entry.accounting_date::text,
         entity.code AS entity_code, ledger.code AS ledger_code,
         entry.functional_currency, entry.description, entry.journal_type_key,
         journal_type.display_name AS type_label, journal_type.owner_module,
         journal_type.correction_route, entry.origin::text, entry.purpose::text,
         entry.status::text, source.source_number,
         CASE WHEN entry.status = 'POSTED' THEN entry.total_debit_functional
              ELSE coalesce((SELECT sum(line.debit_functional)
                             FROM journal_lines line
                             WHERE line.organization_id = entry.organization_id
                               AND line.journal_entry_id = entry.id), 0)
         END::text AS total_debit_functional,
         CASE WHEN entry.status = 'POSTED' THEN entry.total_credit_functional
              ELSE coalesce((SELECT sum(line.credit_functional)
                             FROM journal_lines line
                             WHERE line.organization_id = entry.organization_id
                               AND line.journal_entry_id = entry.id), 0)
         END::text AS total_credit_functional,
         entry.posted_at::text
       FROM journal_entries entry
       JOIN legal_entities entity
         ON entity.organization_id = entry.organization_id
        AND entity.id = entry.legal_entity_id
       JOIN ledgers ledger
         ON ledger.organization_id = entry.organization_id
        AND ledger.id = entry.ledger_id
       JOIN journal_type_definitions journal_type
         ON journal_type.id = entry.journal_type_definition_id
        AND journal_type.key = entry.journal_type_key
        AND journal_type.version = entry.journal_type_version
       LEFT JOIN source_documents source
         ON source.organization_id = entry.organization_id
        AND source.id = entry.source_document_id
       WHERE entry.organization_id = $1 AND entry.id = $2
       LIMIT 1`,
      [principal.organizationId, journalId],
    );
    const header = headerResult.rows[0];
    if (!header) return null;

    const lineResult = await client.query<{
      id: string;
      line_number: number;
      account_code: string;
      account_name: string;
      canonical_key: string;
      account_segment_definitions: unknown;
      memo: string | null;
      transaction_currency: string;
      debit_transaction: string;
      credit_transaction: string;
      fx_rate: string;
      fx_rate_source: string;
      fx_rate_effective_at: string;
      debit_functional: string;
      credit_functional: string;
    }>(
      `SELECT line.id, line.line_number, account.code AS account_code,
         account.display_name AS account_name,
         concat_ws('.', entity.code, account.code,
           coalesce(subaccount.code, '0000'), coalesce(department.code, '0000'),
           coalesce(intercompany.code, '0000'),
           coalesce(custom1.code, '0000'), coalesce(custom2.code, '0000'),
           coalesce(custom3.code, '0000'), coalesce(custom4.code, '0000'),
           coalesce(custom5.code, '0000'), coalesce(custom6.code, '0000'),
           coalesce(custom7.code, '0000'), coalesce(custom8.code, '0000')) AS canonical_key,
         (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'key', definition.key,
              'displayName', definition.display_name,
              'visible', definition.visible
            ) ORDER BY definition.ordinal), '[]'::jsonb)
          FROM segment_definitions definition
          WHERE definition.organization_id = line.organization_id
         ) AS account_segment_definitions,
         line.memo, line.transaction_currency,
         line.debit_transaction::text, line.credit_transaction::text,
         line.fx_rate::text, line.fx_rate_source,
         line.fx_rate_effective_at::text,
         line.debit_functional::text, line.credit_functional::text
       FROM journal_lines line
       JOIN journal_entries entry
         ON entry.organization_id = line.organization_id
        AND entry.id = line.journal_entry_id
       JOIN account_combinations combination
         ON combination.organization_id = line.organization_id
        AND combination.id = line.account_combination_id
       JOIN legal_entities entity
         ON entity.organization_id = combination.organization_id
        AND entity.id = combination.entity_id
       JOIN gl_accounts account
         ON account.organization_id = combination.organization_id
        AND account.id = combination.account_id
       LEFT JOIN segment_values subaccount
         ON subaccount.organization_id = combination.organization_id
        AND subaccount.id = combination.subaccount_id
       LEFT JOIN segment_values department
         ON department.organization_id = combination.organization_id
        AND department.id = combination.department_id
       LEFT JOIN legal_entities intercompany
         ON intercompany.organization_id = combination.organization_id
        AND intercompany.id = combination.intercompany_entity_id
       LEFT JOIN segment_values custom1 ON custom1.organization_id = combination.organization_id AND custom1.id = combination.custom_1_id
       LEFT JOIN segment_values custom2 ON custom2.organization_id = combination.organization_id AND custom2.id = combination.custom_2_id
       LEFT JOIN segment_values custom3 ON custom3.organization_id = combination.organization_id AND custom3.id = combination.custom_3_id
       LEFT JOIN segment_values custom4 ON custom4.organization_id = combination.organization_id AND custom4.id = combination.custom_4_id
       LEFT JOIN segment_values custom5 ON custom5.organization_id = combination.organization_id AND custom5.id = combination.custom_5_id
       LEFT JOIN segment_values custom6 ON custom6.organization_id = combination.organization_id AND custom6.id = combination.custom_6_id
       LEFT JOIN segment_values custom7 ON custom7.organization_id = combination.organization_id AND custom7.id = combination.custom_7_id
       LEFT JOIN segment_values custom8 ON custom8.organization_id = combination.organization_id AND custom8.id = combination.custom_8_id
       WHERE line.organization_id = $1 AND line.journal_entry_id = $2
       ORDER BY line.line_number`,
      [principal.organizationId, journalId],
    );

    return {
      id: header.id,
      number: header.journal_number === null ? "Draft" : String(header.journal_number),
      accountingDate: header.accounting_date,
      entityCode: header.entity_code,
      ledgerCode: header.ledger_code,
      functionalCurrency: header.functional_currency,
      description: header.description,
      typeKey: header.journal_type_key,
      typeLabel: header.type_label,
      ownerModule: header.owner_module,
      origin: header.origin,
      purpose: header.purpose,
      status: header.status,
      sourceNumber: header.source_number,
      sourceHref: trustedSourceHref(
        header.owner_module,
        header.correction_route,
        header.source_number,
      ),
      debitFunctional: header.total_debit_functional,
      creditFunctional: header.total_credit_functional,
      postedAt: header.posted_at,
      lines: lineResult.rows.map((line) => {
        const presentedKey = presentAccountKey(
          line.canonical_key,
          line.account_segment_definitions,
        );
        return {
          id: line.id,
          lineNumber: line.line_number,
          accountCode: line.account_code,
          accountName: line.account_name,
          canonicalKey: presentedKey.canonicalKey,
          displayKey: presentedKey.displayKey,
          displaySegments: presentedKey.displaySegments,
          memo: line.memo,
          transactionCurrency: line.transaction_currency,
          debitTransaction: line.debit_transaction,
          creditTransaction: line.credit_transaction,
          fxRate: line.fx_rate,
          fxRateSource: line.fx_rate_source,
          fxRateEffectiveAt: line.fx_rate_effective_at,
          debitFunctional: line.debit_functional,
          creditFunctional: line.credit_functional,
        };
      }),
    };
  });
}

export async function loadTenantPartyDirectory(
  principal: SessionPrincipal,
  search = "",
  requestedPage = 1,
): Promise<TenantPartyDirectoryDto> {
  const normalizedSearch = search.trim().slice(0, 200);
  const page = normalizeRegisterPage(requestedPage);
  return withWorkspaceTenantRead(readContext(principal), "/app/parties", async (client) => {
    const membership = await assertActiveSessionMembership(client, principal);
    const readiness = await tenantReadiness(client, principal.organizationId);
    const canManage = principalCanWrite(principal) && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.manageParties,
    });
    if (!(await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readParties,
    }))) {
      throw new Error("Party-read permission is required");
    }

    const count = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM parties WHERE organization_id = $1",
      [principal.organizationId],
    );
    if ((count.rows[0]?.count ?? 0) === 0) {
      return {
        demoOnly: membership.isDemo,
        readiness,
        canManage,
        parties: [],
        pagination: {
          page,
          pageSize: registerPageSize,
          hasPrevious: page > 1,
          hasNext: false,
        },
      };
    }

    const activeKey = await loadActiveOrganizationKey(client, principal.organizationId);
    try {
      const searchToken = normalizedSearch
        ? createBlindIndex(normalizedSearch, activeKey.dek, principal.organizationId, "parties.display-name")
        : null;
      const numberPattern = `${normalizedSearch.toUpperCase().replace(/[\\%_]/g, "\\$&")}%`;
      const result = await client.query<{
        id: string;
        party_number: string;
        display_name_ciphertext: string;
        display_name_key_version: number;
        active: boolean;
      }>(
        `SELECT id, party_number, display_name_ciphertext, display_name_key_version, active
         FROM parties
         WHERE organization_id = $1
           AND ($2 = '' OR search_token = $3 OR party_number ILIKE $4 ESCAPE '\\')
         ORDER BY party_number
         LIMIT $5 OFFSET $6`,
        [
          principal.organizationId,
          normalizedSearch,
          searchToken,
          numberPattern,
          registerPageSize + 1,
          (page - 1) * registerPageSize,
        ],
      );
      const partyPage = registerPageWindow(result.rows, page);
      const partyIds = partyPage.rows.map((row) => row.id);
      const accountResult = partyIds.length > 0
        ? await client.query<{
            id: string;
            party_id: string;
            legal_entity_id: string;
            entity_code: string;
            entity_name: string;
            ledger_code: string;
            role: "CUSTOMER" | "SUPPLIER";
            account_number: string;
            transaction_currency: string | null;
            control_account_code: string;
            active: boolean;
          }>(
            `SELECT account.id, account.party_id, account.legal_entity_id,
               entity.code AS entity_code, entity.display_name AS entity_name,
               ledger.code AS ledger_code, account.role, account.account_number,
               account.transaction_currency, control_account.code AS control_account_code,
               account.active
             FROM party_accounts account
             JOIN legal_entities entity
               ON entity.organization_id = account.organization_id
              AND entity.id = account.legal_entity_id
             JOIN ledgers ledger
               ON ledger.organization_id = account.organization_id
              AND ledger.id = account.ledger_id
              AND ledger.legal_entity_id = account.legal_entity_id
             JOIN gl_accounts control_account
               ON control_account.organization_id = account.organization_id
              AND control_account.id = account.control_account_id
              AND control_account.ledger_id = account.ledger_id
             WHERE account.organization_id = $1
               AND account.party_id = ANY($2::uuid[])
             ORDER BY account.party_id, entity.code, account.role, account.account_number`,
            [principal.organizationId, partyIds],
          )
        : { rows: [] };
      const addressResult = partyIds.length > 0
        ? await client.query<{
            id: string;
            party_id: string;
            kind: string;
            ciphertext: string;
            key_version: string;
            valid_from: string;
            valid_to: string | null;
          }>(
            `SELECT id, party_id, kind, ciphertext, key_version,
               valid_from::text, valid_to::text
             FROM party_addresses
             WHERE organization_id = $1
               AND party_id = ANY($2::uuid[])
             ORDER BY party_id, valid_from DESC, kind, id`,
            [principal.organizationId, partyIds],
          )
        : { rows: [] };
      const accountsByParty = new Map<string, TenantPartyAccountDto[]>();
      for (const account of accountResult.rows) {
        const accounts = accountsByParty.get(account.party_id) ?? [];
        accounts.push({
          id: account.id,
          legalEntityId: account.legal_entity_id,
          entityCode: account.entity_code,
          entityName: account.entity_name,
          ledgerCode: account.ledger_code,
          role: account.role,
          accountNumber: account.account_number,
          transactionCurrency: account.transaction_currency,
          controlAccountCode: account.control_account_code,
          active: account.active,
        });
        accountsByParty.set(account.party_id, accounts);
      }
      const addressesByParty = new Map<string, TenantPartyAddressDto[]>();
      for (const address of addressResult.rows) {
        const payload = partyAddressPayloadSchema.parse(JSON.parse(decryptField(
          parseEncryptedField(address.ciphertext),
          activeKey.dek,
          {
            organizationId: principal.organizationId,
            table: "party_addresses",
            column: "ciphertext",
            recordId: address.id,
            keyVersion: Number(address.key_version),
          },
        )));
        const addresses = addressesByParty.get(address.party_id) ?? [];
        addresses.push({
          id: address.id,
          kind: address.kind,
          line1: payload.line1,
          line2: payload.line2 ?? null,
          city: payload.city,
          region: payload.region,
          postalCode: payload.postalCode,
          countryCode: payload.countryCode,
          validFrom: address.valid_from,
          validTo: address.valid_to,
        });
        addressesByParty.set(address.party_id, addresses);
      }
      return {
        demoOnly: membership.isDemo,
        readiness,
        canManage,
        pagination: partyPage.pagination,
        parties: partyPage.rows.map((row) => ({
          id: row.id,
          partyNumber: row.party_number,
          displayName: decryptField(parseEncryptedField(row.display_name_ciphertext), activeKey.dek, {
            organizationId: principal.organizationId,
            table: "parties",
            column: "display_name_ciphertext",
            recordId: row.id,
            keyVersion: row.display_name_key_version,
          }),
          active: row.active,
          accounts: accountsByParty.get(row.id) ?? [],
          addresses: addressesByParty.get(row.id) ?? [],
        })),
      };
    } finally {
      activeKey.dek.fill(0);
    }
  });
}

export async function loadManualJournalOptions(
  principal: SessionPrincipal,
): Promise<ManualJournalOptionsDto> {
  return withWorkspaceTenantRead(readContext(principal), "/app/journals/new", async (client) => {
    await assertActiveSessionMembership(client, principal);
    const canReadLedger = await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readMcpLedger,
    });
    if (!canReadLedger) throw new Error("Ledger read permission is required");
    const canDraft = principalCanWrite(principal) && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.draftJournal,
    });
    const entityPeriods = await client.query<{
      entity_id: string;
      entity_code: string;
      ledger_id: string;
      functional_currency: string;
      period_id: string | null;
      period_label: string | null;
      starts_on: string | null;
      ends_on: string | null;
      period_state: "OPEN" | "ADJUSTMENT_ONLY" | null;
    }>(
      `SELECT entity.id AS entity_id, entity.code AS entity_code,
         ledger.id AS ledger_id, ledger.functional_currency,
         period.id AS period_id, period.label AS period_label,
         period.starts_on::text, period.ends_on::text, period.state AS period_state
       FROM legal_entities entity
       JOIN ledgers ledger
         ON ledger.organization_id = entity.organization_id
        AND ledger.legal_entity_id = entity.id
        AND ledger.kind = 'PRIMARY' AND ledger.active
       LEFT JOIN fiscal_periods period
         ON period.organization_id = ledger.organization_id
        AND period.ledger_id = ledger.id
        AND period.state IN ('OPEN', 'ADJUSTMENT_ONLY')
       WHERE entity.organization_id = $1 AND entity.active
       ORDER BY entity.code, period.starts_on`,
      [principal.organizationId],
    );
    const accountRows = await client.query<{
      entity_id: string;
      combination_id: string;
      account_code: string;
      account_name: string;
    }>(
      `SELECT entity.id AS entity_id, combination.id AS combination_id,
         account.code AS account_code, account.display_name AS account_name
       FROM legal_entities entity
       JOIN ledgers ledger
         ON ledger.organization_id = entity.organization_id
        AND ledger.legal_entity_id = entity.id
        AND ledger.kind = 'PRIMARY' AND ledger.active
       JOIN account_combinations combination
         ON combination.organization_id = ledger.organization_id
        AND combination.ledger_id = ledger.id
        AND combination.entity_id = entity.id AND combination.active
       JOIN gl_accounts account
         ON account.organization_id = combination.organization_id
        AND account.ledger_id = combination.ledger_id
        AND account.id = combination.account_id
        AND account.active AND account.postable AND account.control_kind = 'NONE'
       WHERE entity.organization_id = $1 AND entity.active
       ORDER BY entity.code, account.code, combination.id`,
      [principal.organizationId],
    );
    const entities = new Map<string, {
      id: string;
      code: string;
      ledgerId: string;
      currency: string;
      periods: Map<string, { id: string; label: string; startsOn: string; endsOn: string; state: "OPEN" | "ADJUSTMENT_ONLY" }>;
      accounts: Map<string, { combinationId: string; code: string; displayName: string }>;
    }>();
    for (const row of entityPeriods.rows) {
      let entity = entities.get(row.entity_id);
      if (!entity) {
        entity = {
          id: row.entity_id,
          code: row.entity_code,
          ledgerId: row.ledger_id,
          currency: row.functional_currency,
          periods: new Map(),
          accounts: new Map(),
        };
        entities.set(row.entity_id, entity);
      }
      if (row.period_id && row.period_label && row.starts_on && row.ends_on && row.period_state) {
        entity.periods.set(row.period_id, {
          id: row.period_id,
          label: row.period_label,
          startsOn: row.starts_on,
          endsOn: row.ends_on,
          state: row.period_state,
        });
      }
    }
    for (const row of accountRows.rows) {
      const entity = entities.get(row.entity_id);
      if (!entity) continue;
      entity.accounts.set(row.combination_id, {
        combinationId: row.combination_id,
        code: row.account_code,
        displayName: row.account_name,
      });
    }
    return {
      readOnly: !canDraft,
      entities: [...entities.values()].map((entity) => ({
        id: entity.id,
        code: entity.code,
        ledgerId: entity.ledgerId,
        currency: entity.currency,
        periods: [...entity.periods.values()],
        accounts: [...entity.accounts.values()],
      })),
    };
  });
}

export async function loadPeriodControlWorkspace(
  principal: SessionPrincipal,
): Promise<PeriodControlWorkspaceDto> {
  return withWorkspaceTenantRead(readContext(principal), "/app/controls/period-close", async (client) => {
    const membership = await assertActiveSessionMembership(client, principal);
    const writable = principalCanWrite(principal);
    const canCreate = writable && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.createPeriod,
    });
    const canClose = writable && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.closePeriod,
    });
    const canReopen = writable && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.reopenPeriod,
    });
    const canSeal = writable && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.sealPeriod,
    });
    // Read ledgers independently so an empty calendar can be provisioned.
    const ledgers = await client.query<{
      id: string;
      entity_code: string;
      ledger_code: string;
      functional_currency: string;
    }>(
      `SELECT ledger.id, entity.code AS entity_code, ledger.code AS ledger_code,
         ledger.functional_currency
       FROM ledgers ledger
       JOIN legal_entities entity
         ON entity.organization_id = ledger.organization_id
        AND entity.id = ledger.legal_entity_id AND entity.active
       WHERE ledger.organization_id = $1 AND ledger.active
       ORDER BY entity.code, ledger.code`,
      [principal.organizationId],
    );
    const periods = await client.query<{
      id: string;
      ledger_id: string;
      entity_code: string;
      ledger_code: string;
      functional_currency: string;
      label: string;
      starts_on: string;
      ends_on: string;
      state: "OPEN" | "ADJUSTMENT_ONLY" | "HARD_CLOSED" | "SEALED";
      version: number;
      unposted_journal_count: number;
    }>(
      `SELECT period.id, period.ledger_id, entity.code AS entity_code,
         ledger.code AS ledger_code, ledger.functional_currency,
         period.label, period.starts_on::text, period.ends_on::text,
         period.state, period.version,
         (SELECT count(*)::int
          FROM journal_entries entry
          WHERE entry.organization_id = period.organization_id
            AND entry.period_id = period.id
            AND entry.status IN ('DRAFT', 'SUBMITTED', 'APPROVED')) AS unposted_journal_count
       FROM fiscal_periods period
       JOIN ledgers ledger
         ON ledger.organization_id = period.organization_id
        AND ledger.id = period.ledger_id AND ledger.active
       JOIN legal_entities entity
         ON entity.organization_id = ledger.organization_id
        AND entity.id = ledger.legal_entity_id AND entity.active
       WHERE period.organization_id = $1
       ORDER BY period.fiscal_year DESC, period.period_number DESC, entity.code
       LIMIT 120`,
      [principal.organizationId],
    );
    return {
      demoOnly: membership.isDemo,
      canCreate,
      canClose,
      canReopen,
      canSeal,
      recentStepUp: hasRecentStepUp(principal),
      ledgers: ledgers.rows.map((ledger) => ({
        id: ledger.id,
        entityCode: ledger.entity_code,
        ledgerCode: ledger.ledger_code,
        currency: ledger.functional_currency,
      })),
      periods: periods.rows.map((period) => ({
        id: period.id,
        ledgerId: period.ledger_id,
        entityCode: period.entity_code,
        ledgerCode: period.ledger_code,
        currency: period.functional_currency,
        label: period.label,
        startsOn: period.starts_on,
        endsOn: period.ends_on,
        state: period.state,
        version: period.version,
        unpostedJournalCount: period.unposted_journal_count,
      })),
    };
  });
}
