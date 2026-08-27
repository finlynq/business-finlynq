import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
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

export type TenantReadiness = "EMPTY_ORGANIZATION" | "ENCRYPTION_SETUP_REQUIRED" | "READY";

export type TenantJournalDto = Readonly<{
  id: string;
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
  reversalOfNumber: string | null;
}>;

export type TenantJournalWorkspaceDto = Readonly<{
  demoOnly: boolean;
  readiness: TenantReadiness;
  canDraft: boolean;
  canPost: boolean;
  journals: readonly TenantJournalDto[];
}>;

export type TenantPartyDto = Readonly<{
  id: string;
  partyNumber: string;
  displayName: string;
  active: boolean;
}>;

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
  canClose: boolean;
  canReopen: boolean;
  canSeal: boolean;
  recentStepUp: boolean;
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

async function tenantReadiness(client: PoolClient, organizationId: string, isDemo: boolean): Promise<TenantReadiness> {
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
  if (!isDemo && counts.active_key_count !== 1) return "ENCRYPTION_SETUP_REQUIRED";
  return "READY";
}

export async function loadTenantJournalWorkspace(
  principal: SessionPrincipal,
  search = "",
): Promise<TenantJournalWorkspaceDto> {
  const normalizedSearch = search.trim().slice(0, 100);
  return withTenantTransaction(readContext(principal), async (client) => {
    const membership = await assertActiveSessionMembership(client, principal);
    const readiness = await tenantReadiness(client, principal.organizationId, membership.isDemo);
    const pattern = `%${normalizedSearch.replace(/[\\%_]/g, "\\$&")}%`;
    const journals = await client.query<{
      id: string;
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
      total_debit_functional: string;
      reversal_of_number: number | null;
    }>(
      `SELECT entry.id, entry.journal_number, entry.accounting_date::text,
         entity.code AS entity_code, entry.functional_currency, entry.description,
         entry.journal_type_key, journal_type.display_name AS type_label,
         journal_type.owner_module, journal_type.correction_route, entry.status,
         CASE WHEN entry.status = 'POSTED' THEN entry.total_debit_functional
              ELSE coalesce((SELECT sum(line.debit_functional)
                             FROM journal_lines line
                             WHERE line.organization_id = entry.organization_id
                               AND line.journal_entry_id = entry.id), 0)
         END::text AS total_debit_functional,
         reversed.journal_number AS reversal_of_number
       FROM journal_entries entry
       JOIN legal_entities entity
         ON entity.organization_id = entry.organization_id AND entity.id = entry.legal_entity_id
       JOIN journal_type_definitions journal_type
         ON journal_type.id = entry.journal_type_definition_id
        AND journal_type.key = entry.journal_type_key
        AND journal_type.version = entry.journal_type_version
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
       WHERE entry.organization_id = $1
         AND ($2 = '' OR entry.description ILIKE $3 ESCAPE '\\'
              OR entry.journal_type_key ILIKE $3 ESCAPE '\\'
              OR entity.code ILIKE $3 ESCAPE '\\'
              OR coalesce(entry.journal_number::text, 'draft') ILIKE $3 ESCAPE '\\')
       ORDER BY entry.accounting_date DESC, entry.created_at DESC, entry.id DESC
       LIMIT 100`,
      [principal.organizationId, normalizedSearch, pattern],
    );
    const [canDraft, canPost] = membership.isDemo ? [false, false] : await Promise.all([
      actorHasActivePermission(client, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        permission: PERMISSIONS.draftJournal,
      }),
      actorHasActivePermission(client, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        permission: PERMISSIONS.postJournal,
      }),
    ]);
    return {
      demoOnly: membership.isDemo,
      readiness,
      canDraft,
      canPost,
      journals: journals.rows.map((row) => ({
        id: row.id,
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
        reversalOfNumber: row.reversal_of_number === null ? null : String(row.reversal_of_number),
      })),
    };
  });
}

export async function loadTenantPartyDirectory(
  principal: SessionPrincipal,
  search = "",
): Promise<Readonly<{ demoOnly: boolean; readiness: TenantReadiness; canManage: boolean; parties: readonly TenantPartyDto[] }>> {
  const normalizedSearch = search.trim().slice(0, 200);
  return withTenantTransaction(readContext(principal), async (client) => {
    const membership = await assertActiveSessionMembership(client, principal);
    const readiness = await tenantReadiness(client, principal.organizationId, membership.isDemo);
    const canManage = !membership.isDemo && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.manageParties,
    });
    if (!membership.isDemo && !(await actorHasActivePermission(client, {
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
      return { demoOnly: membership.isDemo, readiness, canManage, parties: [] };
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
         LIMIT 100`,
        [principal.organizationId, normalizedSearch, searchToken, numberPattern],
      );
      return {
        demoOnly: membership.isDemo,
        readiness,
        canManage,
        parties: result.rows.map((row) => ({
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
  return withTenantTransaction(readContext(principal), async (client) => {
    const membership = await assertActiveSessionMembership(client, principal);
    const canDraft = !membership.isDemo && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.draftJournal,
    });
    const result = await client.query<{
      entity_id: string;
      entity_code: string;
      ledger_id: string;
      functional_currency: string;
      period_id: string | null;
      period_label: string | null;
      starts_on: string | null;
      ends_on: string | null;
      period_state: "OPEN" | "ADJUSTMENT_ONLY" | null;
      combination_id: string | null;
      account_code: string | null;
      account_name: string | null;
    }>(
      `SELECT entity.id AS entity_id, entity.code AS entity_code,
         ledger.id AS ledger_id, ledger.functional_currency,
         period.id AS period_id, period.label AS period_label,
         period.starts_on::text, period.ends_on::text, period.state AS period_state,
         combination.id AS combination_id, account.code AS account_code,
         account.display_name AS account_name
       FROM legal_entities entity
       JOIN ledgers ledger
         ON ledger.organization_id = entity.organization_id
        AND ledger.legal_entity_id = entity.id
        AND ledger.kind = 'PRIMARY' AND ledger.active
       LEFT JOIN fiscal_periods period
         ON period.organization_id = ledger.organization_id
        AND period.ledger_id = ledger.id
        AND period.state IN ('OPEN', 'ADJUSTMENT_ONLY')
       LEFT JOIN account_combinations combination
         ON combination.organization_id = ledger.organization_id
        AND combination.ledger_id = ledger.id
        AND combination.entity_id = entity.id AND combination.active
       LEFT JOIN gl_accounts account
         ON account.organization_id = combination.organization_id
        AND account.ledger_id = combination.ledger_id
        AND account.id = combination.account_id
        AND account.active AND account.postable AND account.control_kind = 'NONE'
       WHERE entity.organization_id = $1 AND entity.active
       ORDER BY entity.code, period.starts_on, account.code`,
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
    for (const row of result.rows) {
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
      if (row.combination_id && row.account_code && row.account_name) {
        entity.accounts.set(row.combination_id, {
          combinationId: row.combination_id,
          code: row.account_code,
          displayName: row.account_name,
        });
      }
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
  return withTenantTransaction(readContext(principal), async (client) => {
    const membership = await assertActiveSessionMembership(client, principal);
    if (membership.isDemo) {
      return { canClose: false, canReopen: false, canSeal: false, recentStepUp: false, periods: [] };
    }
    const [canClose, canReopen, canSeal] = await Promise.all([
      actorHasActivePermission(client, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        permission: PERMISSIONS.closePeriod,
      }),
      actorHasActivePermission(client, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        permission: PERMISSIONS.reopenPeriod,
      }),
      actorHasActivePermission(client, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        permission: PERMISSIONS.sealPeriod,
      }),
    ]);
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
      canClose,
      canReopen,
      canSeal,
      recentStepUp: hasRecentStepUp(principal),
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
