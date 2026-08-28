import "server-only";

import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { actorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { transactionAuthMethod, type SessionPrincipal } from "@/modules/identity/session";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";
import {
  decryptField,
  parseEncryptedField,
} from "@/security/organization-encryption";
import { loadActiveOrganizationKey } from "@/security/organization-key-store";
import {
  bankRuleActionSchema,
  bankRuleConditionSchema,
  type BankRuleAction,
  type BankRuleCondition,
} from "./banking-service";

export type BankingWorkspaceDto = Readonly<{
  isDemo: boolean;
  feedEnabled: boolean;
  permissions: Readonly<{
    read: boolean;
    connect: boolean;
    sync: boolean;
    reconcilePrepare: boolean;
    reconcileReview: boolean;
    rules: boolean;
  }>;
  connections: readonly Readonly<{
    id: string;
    provider: string;
    displayName: string;
    status: string;
    lastSyncedAt: string | null;
    lastErrorCode: string | null;
  }>[];
  accounts: readonly Readonly<{
    id: string;
    connectionId: string;
    displayName: string;
    currencyCode: string;
    active: boolean;
    legalEntityId: string | null;
    entityCode: string | null;
    ledgerId: string | null;
    accountCombinationId: string | null;
    accountCode: string | null;
    accountName: string | null;
    latestBalance: string | null;
    latestBalanceAt: string | null;
    observationCount: number;
  }>[];
  cashAccounts: readonly Readonly<{
    id: string;
    legalEntityId: string;
    entityCode: string;
    ledgerId: string;
    ledgerCode: string;
    currencyCode: string;
    accountCode: string;
    accountName: string;
  }>[];
  ruleTargetAccounts: readonly Readonly<{
    id: string;
    legalEntityId: string;
    entityCode: string;
    ledgerId: string;
    ledgerCode: string;
    functionalCurrency: string;
    accountCode: string;
    accountName: string;
    accountClass: string;
  }>[];
  syncRuns: readonly Readonly<{
    id: string;
    connectionId: string;
    status: string;
    accountCount: number;
    observationCount: number;
    versionCount: number;
    warningCount: number;
    errorCode: string | null;
    startedAt: string;
    completedAt: string | null;
  }>[];
  observations: readonly Readonly<{
    versionId: string;
    accountId: string;
    accountName: string;
    postedOn: string;
    amount: string;
    currencyCode: string;
    status: string;
    payee: string;
    memo: string | null;
    hasProposal: boolean;
    matched: boolean;
  }>[];
  reconciliations: readonly Readonly<{
    id: string;
    accountId: string;
    accountName: string;
    statementStartOn: string;
    statementEndOn: string;
    openingBalance: string;
    closingBalance: string;
    currencyCode: string;
    status: string;
    createdAt: string;
    matchCount: number;
    voidReason: string | null;
    voidedAt: string | null;
  }>[];
  rules: readonly Readonly<{
    id: string;
    name: string;
    priority: number;
    state: string;
    version: number;
    condition: BankRuleCondition | null;
    action: BankRuleAction | null;
    createdAt: string;
  }>[];
  proposalCount: number;
  proposals: readonly Readonly<{
    id: string;
    ruleId: string | null;
    ruleName: string | null;
    observationVersionId: string;
    accountName: string;
    postedOn: string;
    amount: string;
    currencyCode: string;
    payee: string;
    action: BankRuleAction | null;
    createdAt: string;
  }>[];
  activeReconciliation: Readonly<{
    id: string;
    status: string;
    currencyCode: string;
    statementMovement: string;
    observationTotal: string;
    ledgerTotal: string;
    statementToBankDifference: string;
    unexplainedDifference: string;
    unmatchedObservationCount: number;
    unmatchedLedgerLineCount: number;
    matchHash: string;
    voidReason: string | null;
    voidedAt: string | null;
    observations: readonly Readonly<{
      versionId: string;
      postedOn: string;
      payee: string;
      amount: string;
      allocated: string;
      remaining: string;
    }>[];
    ledgerLines: readonly Readonly<{
      lineId: string;
      journalId: string;
      journalLabel: string;
      accountingDate: string;
      description: string;
      memo: string | null;
      amount: string;
      allocated: string;
      remaining: string;
    }>[];
    allocations: readonly Readonly<{
      id: string;
      observationVersionId: string;
      journalLineId: string;
      allocatedAmount: string;
      createdAt: string;
    }>[];
  }> | null;
}>;

function readContext(principal: SessionPrincipal) {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId: `banking-workspace:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "UI" as const,
  };
}

function safeDecrypt(input: Readonly<{
  ciphertext: string;
  organizationId: string;
  table: string;
  column: string;
  recordId: string;
  keyVersion: number;
  activeKeyVersion: number;
  dek: Buffer;
}>): string | null {
  if (input.keyVersion !== input.activeKeyVersion) return null;
  try {
    return decryptField(parseEncryptedField(input.ciphertext), input.dek, {
      organizationId: input.organizationId,
      table: input.table,
      column: input.column,
      recordId: input.recordId,
      keyVersion: input.keyVersion,
    });
  } catch {
    return null;
  }
}

export async function loadBankingWorkspace(
  principal: SessionPrincipal,
  selectedReconciliationId?: string,
): Promise<BankingWorkspaceDto> {
  return withWorkspaceTenantRead(readContext(principal), "/app/banking", async (client) => {
    const [canRead, canConnect, canSync, canPrepareReconciliation, canReviewReconciliation, canManageRules] = await Promise.all([
      actorHasActivePermission(client, { organizationId: principal.organizationId, actorId: principal.userId, permission: PERMISSIONS.readBanking }),
      actorHasActivePermission(client, { organizationId: principal.organizationId, actorId: principal.userId, permission: PERMISSIONS.manageBankConnections }),
      actorHasActivePermission(client, { organizationId: principal.organizationId, actorId: principal.userId, permission: PERMISSIONS.syncBanking }),
      actorHasActivePermission(client, { organizationId: principal.organizationId, actorId: principal.userId, permission: PERMISSIONS.prepareBankReconciliation }),
      actorHasActivePermission(client, { organizationId: principal.organizationId, actorId: principal.userId, permission: PERMISSIONS.reviewBankReconciliation }),
      actorHasActivePermission(client, { organizationId: principal.organizationId, actorId: principal.userId, permission: PERMISSIONS.manageBankRules }),
    ]);
    if (!canRead) throw new Error("Banking read permission is required");

    const [connectionsResult, ruleTargetResult, accountsResult, cashResult, syncResult, observationsResult, reconciliationResult, rulesResult, proposalsResult, proposalDetailsResult] = await Promise.all([
      client.query<{
        id: string; provider: string; display_name: string; status: string;
        last_synced_at: string | null; last_error_code: string | null;
      }>(
        `SELECT id, provider, display_name, status, last_synced_at::text, last_error_code
         FROM bank_connections WHERE organization_id = $1 ORDER BY created_at, id`,
        [principal.organizationId],
      ),
      client.query<{
        id: string; legal_entity_id: string; entity_code: string; ledger_id: string;
        ledger_code: string; functional_currency: string; account_code: string;
        account_name: string; account_class: string;
      }>(
        `SELECT combination.id, combination.entity_id AS legal_entity_id,
           entity.code AS entity_code, combination.ledger_id, ledger.code AS ledger_code,
           ledger.functional_currency, account.code AS account_code,
           account.display_name AS account_name, account.class AS account_class
         FROM account_combinations combination
         JOIN legal_entities entity
           ON entity.organization_id = combination.organization_id AND entity.id = combination.entity_id AND entity.active
         JOIN ledgers ledger
           ON ledger.organization_id = combination.organization_id AND ledger.id = combination.ledger_id AND ledger.active
         JOIN gl_accounts account
           ON account.organization_id = combination.organization_id
          AND account.ledger_id = combination.ledger_id AND account.id = combination.account_id
          AND account.active AND account.postable AND account.control_kind = 'NONE'
         WHERE combination.organization_id = $1 AND combination.active
         ORDER BY entity.code, account.class, account.code, combination.id`,
        [principal.organizationId],
      ),
      client.query<{
        id: string; connection_id: string; display_name_ciphertext: string; key_version: number;
        currency_code: string; active: boolean; legal_entity_id: string | null;
        entity_code: string | null; ledger_id: string | null;
        cash_account_combination_id: string | null; account_code: string | null;
        account_name: string | null; latest_balance: string | null;
        latest_balance_at: string | null; observation_count: number;
      }>(
        `SELECT external.id, external.connection_id, external.display_name_ciphertext,
           external.key_version, external.currency_code, external.active,
           external.legal_entity_id, entity.code AS entity_code, external.ledger_id,
           external.cash_account_combination_id, account.code AS account_code,
           account.display_name AS account_name, balance.balance::text AS latest_balance,
           balance.balance_at::text AS latest_balance_at,
           (SELECT count(*)::int FROM bank_observations observation
             WHERE observation.organization_id = external.organization_id
               AND observation.external_account_id = external.id) AS observation_count
         FROM bank_external_accounts external
         LEFT JOIN legal_entities entity
           ON entity.organization_id = external.organization_id AND entity.id = external.legal_entity_id
         LEFT JOIN account_combinations combination
           ON combination.organization_id = external.organization_id
          AND combination.id = external.cash_account_combination_id
         LEFT JOIN gl_accounts account
           ON account.organization_id = combination.organization_id AND account.id = combination.account_id
         LEFT JOIN LATERAL (
           SELECT anchor.balance, anchor.balance_at
           FROM bank_balance_anchors anchor
           WHERE anchor.organization_id = external.organization_id
             AND anchor.external_account_id = external.id
           ORDER BY anchor.balance_at DESC, anchor.observed_at DESC LIMIT 1
         ) balance ON true
         WHERE external.organization_id = $1
         ORDER BY external.created_at, external.id`,
        [principal.organizationId],
      ),
      client.query<{
        id: string; legal_entity_id: string; entity_code: string; ledger_id: string;
        ledger_code: string; currency_code: string; account_code: string; account_name: string;
      }>(
        `SELECT combination.id, combination.entity_id AS legal_entity_id,
           entity.code AS entity_code, combination.ledger_id, ledger.code AS ledger_code,
           ledger.functional_currency AS currency_code,
           account.code AS account_code, account.display_name AS account_name
         FROM account_combinations combination
         JOIN legal_entities entity
           ON entity.organization_id = combination.organization_id AND entity.id = combination.entity_id AND entity.active
         JOIN ledgers ledger
           ON ledger.organization_id = combination.organization_id AND ledger.id = combination.ledger_id AND ledger.active
         JOIN gl_accounts account
           ON account.organization_id = combination.organization_id AND account.id = combination.account_id
          AND account.active AND account.postable AND account.class = 'ASSET' AND account.control_kind = 'NONE'
         WHERE combination.organization_id = $1 AND combination.active
         ORDER BY entity.code, account.code, combination.id`,
        [principal.organizationId],
      ),
      client.query<{
        id: string; connection_id: string; status: string; account_count: number;
        observation_count: number; version_count: number; provider_warning_count: number;
        error_code: string | null; started_at: string; completed_at: string | null;
      }>(
        `SELECT id, connection_id, status, account_count, observation_count,
           version_count, provider_warning_count, error_code,
           started_at::text, completed_at::text
         FROM bank_sync_runs WHERE organization_id = $1
         ORDER BY started_at DESC, id DESC LIMIT 30`,
        [principal.organizationId],
      ),
      client.query<{
        id: string; external_account_id: string; details_ciphertext: string; key_version: number;
        posted_on: string; amount: string; currency_code: string; status: string;
        has_proposal: boolean; matched: boolean;
      }>(
        `SELECT latest.id, observation.external_account_id, latest.details_ciphertext,
           latest.key_version, latest.posted_on::text, latest.amount::text,
           latest.currency_code, latest.status,
           EXISTS (SELECT 1 FROM bank_draft_proposals proposal
             WHERE proposal.organization_id = latest.organization_id
               AND proposal.observation_version_id = latest.id) AS has_proposal,
           EXISTS (SELECT 1 FROM bank_match_allocations allocation
             JOIN bank_reconciliation_sessions allocated_session
               ON allocated_session.organization_id = allocation.organization_id
              AND allocated_session.id = allocation.reconciliation_session_id
              AND allocated_session.status <> 'VOIDED'
             LEFT JOIN bank_match_allocation_voids void
               ON void.organization_id = allocation.organization_id AND void.allocation_id = allocation.id
             WHERE allocation.organization_id = latest.organization_id
               AND allocation.observation_version_id = latest.id AND void.id IS NULL) AS matched
         FROM bank_observations observation
         JOIN LATERAL (
           SELECT version.* FROM bank_observation_versions version
           WHERE version.organization_id = observation.organization_id
             AND version.observation_id = observation.id
           ORDER BY version.version_number DESC LIMIT 1
         ) latest ON true
         WHERE observation.organization_id = $1
         ORDER BY latest.posted_on DESC, latest.observed_at DESC, latest.id DESC LIMIT 200`,
        [principal.organizationId],
      ),
      client.query<{
        id: string; external_account_id: string; cash_account_combination_id: string;
        statement_start_on: string;
        statement_end_on: string; opening_balance: string; closing_balance: string;
        currency_code: string; status: string; created_at: string; match_count: number;
        void_reason: string | null; voided_at: string | null;
        finalized_observation_total: string | null; finalized_ledger_total: string | null;
        finalized_unexplained_difference: string | null; finalized_match_hash: string | null;
      }>(
        `SELECT reconciliation.id, reconciliation.external_account_id,
           reconciliation.cash_account_combination_id,
           reconciliation.statement_start_on::text, reconciliation.statement_end_on::text,
           reconciliation.opening_balance::text, reconciliation.closing_balance::text,
           reconciliation.currency_code, reconciliation.status, reconciliation.created_at::text,
           reconciliation.finalized_observation_total::text,
           reconciliation.finalized_ledger_total::text,
           reconciliation.finalized_unexplained_difference::text,
           reconciliation.finalized_match_hash,
           void.reason AS void_reason, void.created_at::text AS voided_at,
           (SELECT count(*)::int FROM bank_match_allocations allocation
             LEFT JOIN bank_match_allocation_voids void
               ON void.organization_id = allocation.organization_id AND void.allocation_id = allocation.id
             WHERE allocation.organization_id = reconciliation.organization_id
               AND allocation.reconciliation_session_id = reconciliation.id
               AND void.id IS NULL) AS match_count
         FROM bank_reconciliation_sessions reconciliation
         LEFT JOIN bank_reconciliation_voids void
           ON void.organization_id = reconciliation.organization_id
          AND void.reconciliation_session_id = reconciliation.id
         WHERE reconciliation.organization_id = $1
         ORDER BY reconciliation.statement_end_on DESC, reconciliation.created_at DESC LIMIT 100`,
        [principal.organizationId],
      ),
      client.query<{
        id: string; name: string; priority: number; state: string; condition_ciphertext: string;
        action_ciphertext: string; key_version: number; version: number; created_at: string;
      }>(
        `SELECT id, name, priority, state, condition_ciphertext,
           action_ciphertext, key_version, version, created_at::text
         FROM bank_rules rule WHERE organization_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM bank_rules successor
             WHERE successor.organization_id = rule.organization_id
               AND successor.supersedes_rule_id = rule.id
           )
         ORDER BY priority, created_at, id LIMIT 200`,
        [principal.organizationId],
      ),
      client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM bank_draft_proposals WHERE organization_id = $1",
        [principal.organizationId],
      ),
      client.query<{
        id: string; observation_version_id: string; rule_id: string | null; rule_name: string | null;
        payload_ciphertext: string; payload_key_version: number; created_at: string;
        details_ciphertext: string; details_key_version: number; posted_on: string;
        amount: string; currency_code: string; external_account_id: string;
      }>(
        `SELECT proposal.id, proposal.observation_version_id, proposal.rule_id,
           rule.name AS rule_name, proposal.payload_ciphertext,
           proposal.key_version AS payload_key_version, proposal.created_at::text,
           version.details_ciphertext, version.key_version AS details_key_version,
           version.posted_on::text, version.amount::text, version.currency_code,
           observation.external_account_id
         FROM bank_draft_proposals proposal
         JOIN bank_observation_versions version
           ON version.organization_id = proposal.organization_id
          AND version.id = proposal.observation_version_id
         JOIN bank_observations observation
           ON observation.organization_id = version.organization_id
          AND observation.id = version.observation_id
         LEFT JOIN bank_rules rule
           ON rule.organization_id = proposal.organization_id AND rule.id = proposal.rule_id
         WHERE proposal.organization_id = $1
         ORDER BY proposal.created_at DESC, proposal.id DESC LIMIT 200`,
        [principal.organizationId],
      ),
    ]);

    const selectedReconciliation = selectedReconciliationId
      ? reconciliationResult.rows.find((row) => row.id === selectedReconciliationId) ?? null
      : reconciliationResult.rows[0] ?? null;
    const [reconciliationObservationsResult, reconciliationLinesResult, reconciliationAllocationsResult] = selectedReconciliation
      ? await Promise.all([
        client.query<{
          id: string; details_ciphertext: string; key_version: number; posted_on: string;
          amount: string; allocated: string; session_allocated: string;
        }>(
          `WITH current_version AS (
             SELECT DISTINCT ON (observation.id)
               version.id, version.details_ciphertext, version.key_version,
               version.posted_on, version.amount, version.status, version.currency_code
             FROM bank_observations observation
             JOIN bank_observation_versions version
               ON version.organization_id = observation.organization_id
              AND version.observation_id = observation.id
             WHERE observation.organization_id = $1
               AND observation.external_account_id = $2
             ORDER BY observation.id, version.version_number DESC
           ), latest AS (
             SELECT * FROM current_version
             WHERE posted_on BETWEEN $4::date AND $5::date
               AND currency_code = $6
           )
           SELECT latest.id, latest.details_ciphertext, latest.key_version,
             latest.posted_on::text, latest.amount::text,
             coalesce(sum(allocation.allocated_amount) FILTER (
               WHERE void.id IS NULL AND allocated_session.id IS NOT NULL
             ), 0)::text AS allocated,
             coalesce(sum(allocation.allocated_amount) FILTER (
               WHERE void.id IS NULL AND allocated_session.id IS NOT NULL
                 AND allocation.reconciliation_session_id = $3
             ), 0)::text AS session_allocated
           FROM latest
           LEFT JOIN bank_match_allocations allocation
             ON allocation.organization_id = $1
             AND allocation.observation_version_id = latest.id
           LEFT JOIN bank_reconciliation_sessions allocated_session
             ON allocated_session.organization_id = allocation.organization_id
            AND allocated_session.id = allocation.reconciliation_session_id
            AND allocated_session.status <> 'VOIDED'
           LEFT JOIN bank_match_allocation_voids void
             ON void.organization_id = allocation.organization_id AND void.allocation_id = allocation.id
           WHERE latest.status = 'POSTED'
           GROUP BY latest.id, latest.details_ciphertext, latest.key_version, latest.posted_on, latest.amount
           ORDER BY latest.posted_on, latest.id`,
          [principal.organizationId, selectedReconciliation.external_account_id,
            selectedReconciliation.id, selectedReconciliation.statement_start_on,
            selectedReconciliation.statement_end_on, selectedReconciliation.currency_code],
        ),
        client.query<{
          id: string; journal_id: string; journal_label: string; accounting_date: string;
          description: string; memo: string | null; amount: string; allocated: string;
          session_allocated: string;
        }>(
          `SELECT line.id, journal.id AS journal_id,
             coalesce(journal.journal_number, journal.description) AS journal_label,
             journal.accounting_date::text, journal.description, line.memo,
             (line.debit_transaction - line.credit_transaction)::text AS amount,
             coalesce(sum(allocation.allocated_amount) FILTER (
               WHERE void.id IS NULL AND allocated_session.id IS NOT NULL
             ), 0)::text AS allocated,
             coalesce(sum(allocation.allocated_amount) FILTER (
               WHERE void.id IS NULL AND allocated_session.id IS NOT NULL
                 AND allocation.reconciliation_session_id = $2
             ), 0)::text AS session_allocated
           FROM journal_lines line
           JOIN journal_entries journal
             ON journal.organization_id = line.organization_id
            AND journal.id = line.journal_entry_id AND journal.status = 'POSTED'
           LEFT JOIN bank_match_allocations allocation
             ON allocation.organization_id = $1
             AND allocation.journal_line_id = line.id
           LEFT JOIN bank_reconciliation_sessions allocated_session
             ON allocated_session.organization_id = allocation.organization_id
            AND allocated_session.id = allocation.reconciliation_session_id
            AND allocated_session.status <> 'VOIDED'
           LEFT JOIN bank_match_allocation_voids void
             ON void.organization_id = allocation.organization_id AND void.allocation_id = allocation.id
           WHERE line.organization_id = $1
             AND line.account_combination_id = $3
             AND line.transaction_currency = $5
             AND journal.accounting_date BETWEEN $4::date AND $6::date
           GROUP BY line.id, journal.id
           ORDER BY journal.accounting_date, journal.id, line.line_number`,
          [principal.organizationId, selectedReconciliation.id,
            selectedReconciliation.cash_account_combination_id,
            selectedReconciliation.statement_start_on, selectedReconciliation.currency_code,
            selectedReconciliation.statement_end_on],
        ),
        client.query<{
          id: string; observation_version_id: string; journal_line_id: string;
          allocated_amount: string; created_at: string;
        }>(
          `SELECT allocation.id, allocation.observation_version_id,
             allocation.journal_line_id, allocation.allocated_amount::text,
             allocation.created_at::text
           FROM bank_match_allocations allocation
           LEFT JOIN bank_match_allocation_voids void
             ON void.organization_id = allocation.organization_id AND void.allocation_id = allocation.id
           WHERE allocation.organization_id = $1
             AND allocation.reconciliation_session_id = $2 AND void.id IS NULL
           ORDER BY allocation.id`,
          [principal.organizationId, selectedReconciliation.id],
        ),
      ])
      : [null, null, null] as const;

    const encryptedRowsExist = accountsResult.rows.length > 0 || rulesResult.rows.length > 0 || observationsResult.rows.length > 0 || proposalDetailsResult.rows.length > 0 || (reconciliationObservationsResult?.rows.length ?? 0) > 0;
    const activeKey = encryptedRowsExist
      ? await loadActiveOrganizationKey(client, principal.organizationId)
      : null;
    try {
      const accountNames = new Map<string, string>();
      const accounts = accountsResult.rows.map((row) => {
        const decrypted = activeKey ? safeDecrypt({
          ciphertext: row.display_name_ciphertext,
          organizationId: principal.organizationId,
          table: "bank_external_accounts",
          column: "display_name_ciphertext",
          recordId: row.id,
          keyVersion: row.key_version,
          activeKeyVersion: activeKey.keyVersion,
          dek: activeKey.dek,
        }) : null;
        const displayName = decrypted ?? "Encrypted bank account";
        accountNames.set(row.id, displayName);
        return {
          id: row.id,
          connectionId: row.connection_id,
          displayName,
          currencyCode: row.currency_code,
          active: row.active,
          legalEntityId: row.legal_entity_id,
          entityCode: row.entity_code,
          ledgerId: row.ledger_id,
          accountCombinationId: row.cash_account_combination_id,
          accountCode: row.account_code,
          accountName: row.account_name,
          latestBalance: row.latest_balance,
          latestBalanceAt: row.latest_balance_at,
          observationCount: row.observation_count,
        };
      });
      const observations = observationsResult.rows.map((row) => {
        let details: { payee?: unknown; description?: unknown; memo?: unknown } = {};
        if (activeKey) {
          const plaintext = safeDecrypt({
            ciphertext: row.details_ciphertext,
            organizationId: principal.organizationId,
            table: "bank_observation_versions",
            column: "details_ciphertext",
            recordId: row.id,
            keyVersion: row.key_version,
            activeKeyVersion: activeKey.keyVersion,
            dek: activeKey.dek,
          });
          try { details = plaintext ? JSON.parse(plaintext) as typeof details : {}; } catch { details = {}; }
        }
        const payee = typeof details.payee === "string" && details.payee
          ? details.payee
          : typeof details.description === "string" && details.description
            ? details.description
            : "Encrypted bank transaction";
        return {
          versionId: row.id,
          accountId: row.external_account_id,
          accountName: accountNames.get(row.external_account_id) ?? "Bank account",
          postedOn: row.posted_on,
          amount: row.amount,
          currencyCode: row.currency_code,
          status: row.status,
          payee,
          memo: typeof details.memo === "string" ? details.memo : null,
          hasProposal: row.has_proposal,
          matched: row.matched,
        };
      });
      const rules = rulesResult.rows.map((row) => {
        let condition: BankRuleCondition | null = null;
        let action: BankRuleAction | null = null;
        if (activeKey) {
          const conditionText = safeDecrypt({
            ciphertext: row.condition_ciphertext, organizationId: principal.organizationId,
            table: "bank_rules", column: "condition_ciphertext", recordId: row.id,
            keyVersion: row.key_version, activeKeyVersion: activeKey.keyVersion, dek: activeKey.dek,
          });
          const actionText = safeDecrypt({
            ciphertext: row.action_ciphertext, organizationId: principal.organizationId,
            table: "bank_rules", column: "action_ciphertext", recordId: row.id,
            keyVersion: row.key_version, activeKeyVersion: activeKey.keyVersion, dek: activeKey.dek,
          });
          try { condition = conditionText ? bankRuleConditionSchema.parse(JSON.parse(conditionText)) : null; } catch { condition = null; }
          try { action = actionText ? bankRuleActionSchema.parse(JSON.parse(actionText)) : null; } catch { action = null; }
        }
        return {
          id: row.id, name: row.name, priority: row.priority, state: row.state, version: row.version,
          condition, action, createdAt: row.created_at,
        };
      });
      const proposals = proposalDetailsResult.rows.map((row) => {
        let action: BankRuleAction | null = null;
        let details: { payee?: unknown; description?: unknown } = {};
        if (activeKey) {
          const payloadText = safeDecrypt({
            ciphertext: row.payload_ciphertext, organizationId: principal.organizationId,
            table: "bank_draft_proposals", column: "payload_ciphertext", recordId: row.id,
            keyVersion: row.payload_key_version, activeKeyVersion: activeKey.keyVersion, dek: activeKey.dek,
          });
          const detailsText = safeDecrypt({
            ciphertext: row.details_ciphertext, organizationId: principal.organizationId,
            table: "bank_observation_versions", column: "details_ciphertext", recordId: row.observation_version_id,
            keyVersion: row.details_key_version, activeKeyVersion: activeKey.keyVersion, dek: activeKey.dek,
          });
          try {
            const payload = payloadText ? JSON.parse(payloadText) as { action?: unknown } : {};
            action = bankRuleActionSchema.parse(payload.action);
          } catch { action = null; }
          try { details = detailsText ? JSON.parse(detailsText) as typeof details : {}; } catch { details = {}; }
        }
        return {
          id: row.id,
          ruleId: row.rule_id,
          ruleName: row.rule_name,
          observationVersionId: row.observation_version_id,
          accountName: accountNames.get(row.external_account_id) ?? "Bank account",
          postedOn: row.posted_on,
          amount: row.amount,
          currencyCode: row.currency_code,
          payee: typeof details.payee === "string" && details.payee
            ? details.payee
            : typeof details.description === "string" && details.description
              ? details.description
              : "Encrypted bank transaction",
          action,
          createdAt: row.created_at,
        };
      });

      let activeReconciliation: BankingWorkspaceDto["activeReconciliation"] = null;
      if (selectedReconciliation && reconciliationObservationsResult && reconciliationLinesResult && reconciliationAllocationsResult) {
        const observationRows = reconciliationObservationsResult.rows.map((row) => {
          let details: { payee?: unknown; description?: unknown } = {};
          if (activeKey) {
            const plaintext = safeDecrypt({
              ciphertext: row.details_ciphertext,
              organizationId: principal.organizationId,
              table: "bank_observation_versions",
              column: "details_ciphertext",
              recordId: row.id,
              keyVersion: row.key_version,
              activeKeyVersion: activeKey.keyVersion,
              dek: activeKey.dek,
            });
            try { details = plaintext ? JSON.parse(plaintext) as typeof details : {}; } catch { details = {}; }
          }
          const amount = new Decimal(row.amount);
          const allocated = new Decimal(row.allocated);
          return {
            versionId: row.id,
            postedOn: row.posted_on,
            payee: typeof details.payee === "string" && details.payee
              ? details.payee
              : typeof details.description === "string" && details.description
                ? details.description
                : "Encrypted bank transaction",
            amount: amount.toFixed(9),
            allocated: allocated.toFixed(9),
            remaining: amount.abs().minus(allocated).toFixed(9),
          };
        });
        const lineRows = reconciliationLinesResult.rows.map((row) => {
          const amount = new Decimal(row.amount);
          const allocated = new Decimal(row.allocated);
          return {
            lineId: row.id,
            journalId: row.journal_id,
            journalLabel: row.journal_label,
            accountingDate: row.accounting_date,
            description: row.description,
            memo: row.memo,
            amount: amount.toFixed(9),
            allocated: allocated.toFixed(9),
            remaining: amount.abs().minus(allocated).toFixed(9),
          };
        });
        const observationTotal = observationRows.reduce((total, row) => total.plus(row.amount), new Decimal(0));
        const observationAmountById = new Map(observationRows.map((row) => [row.versionId, new Decimal(row.amount)]));
        const lineAmountById = new Map(lineRows.map((row) => [row.lineId, new Decimal(row.amount)]));
        let invalidAllocationCount = 0;
        const ledgerTotal = reconciliationAllocationsResult.rows.reduce((total, allocation) => {
          const observationAmount = observationAmountById.get(allocation.observation_version_id);
          const lineAmount = lineAmountById.get(allocation.journal_line_id);
          if (!observationAmount || !lineAmount || lineAmount.isZero()
            || observationAmount.isPositive() !== lineAmount.isPositive()) {
            invalidAllocationCount += 1;
            return total;
          }
          const allocated = new Decimal(allocation.allocated_amount);
          return total.plus(lineAmount.isPositive() ? allocated : allocated.negated());
        }, new Decimal(0));
        const statementMovement = new Decimal(selectedReconciliation.closing_balance).minus(selectedReconciliation.opening_balance);
        const liveMatchHash = createHash("sha256").update(JSON.stringify(reconciliationAllocationsResult.rows.map((row) => ({
          id: row.id,
          observation_version_id: row.observation_version_id,
          journal_line_id: row.journal_line_id,
          allocated_amount: row.allocated_amount,
        }))), "utf8").digest("hex");
        const finalized = selectedReconciliation.status === "FINALIZED";
        const displayedObservationTotal = finalized && selectedReconciliation.finalized_observation_total !== null
          ? new Decimal(selectedReconciliation.finalized_observation_total)
          : observationTotal;
        const displayedLedgerTotal = finalized && selectedReconciliation.finalized_ledger_total !== null
          ? new Decimal(selectedReconciliation.finalized_ledger_total)
          : ledgerTotal;
        const displayedUnexplainedDifference = finalized && selectedReconciliation.finalized_unexplained_difference !== null
          ? new Decimal(selectedReconciliation.finalized_unexplained_difference)
          : statementMovement.minus(displayedLedgerTotal);
        activeReconciliation = {
          id: selectedReconciliation.id,
          status: selectedReconciliation.status,
          currencyCode: selectedReconciliation.currency_code,
          statementMovement: statementMovement.toFixed(9),
          observationTotal: displayedObservationTotal.toFixed(9),
          ledgerTotal: displayedLedgerTotal.toFixed(9),
          statementToBankDifference: statementMovement.minus(displayedObservationTotal).toFixed(9),
          unexplainedDifference: displayedUnexplainedDifference.toFixed(9),
          unmatchedObservationCount: finalized ? 0 : reconciliationObservationsResult.rows.filter((row) => (
            !new Decimal(row.amount).abs().equals(row.session_allocated)
          )).length,
          unmatchedLedgerLineCount: finalized ? 0 : invalidAllocationCount,
          matchHash: finalized ? selectedReconciliation.finalized_match_hash ?? liveMatchHash : liveMatchHash,
          voidReason: selectedReconciliation.void_reason,
          voidedAt: selectedReconciliation.voided_at,
          observations: observationRows,
          ledgerLines: lineRows,
          allocations: reconciliationAllocationsResult.rows.map((row) => ({
            id: row.id,
            observationVersionId: row.observation_version_id,
            journalLineId: row.journal_line_id,
            allocatedAmount: row.allocated_amount,
            createdAt: row.created_at,
          })),
        };
      }

      return {
        isDemo: principal.sessionMode === "demo",
        feedEnabled: process.env.BANK_FEEDS_ENABLED === "true",
        permissions: {
          read: canRead,
          connect: canConnect && principal.sessionMode === "real",
          sync: canSync && principal.sessionMode === "real",
          reconcilePrepare: canPrepareReconciliation,
          reconcileReview: canReviewReconciliation,
          rules: canManageRules,
        },
        connections: connectionsResult.rows.map((row) => ({
          id: row.id, provider: row.provider, displayName: row.display_name,
          status: row.status, lastSyncedAt: row.last_synced_at, lastErrorCode: row.last_error_code,
        })),
        accounts,
        cashAccounts: cashResult.rows.map((row) => ({
          id: row.id, legalEntityId: row.legal_entity_id, entityCode: row.entity_code,
          ledgerId: row.ledger_id, ledgerCode: row.ledger_code,
          currencyCode: row.currency_code,
          accountCode: row.account_code, accountName: row.account_name,
        })),
        ruleTargetAccounts: ruleTargetResult.rows.map((row) => ({
          id: row.id, legalEntityId: row.legal_entity_id, entityCode: row.entity_code,
          ledgerId: row.ledger_id, ledgerCode: row.ledger_code,
          functionalCurrency: row.functional_currency, accountCode: row.account_code,
          accountName: row.account_name, accountClass: row.account_class,
        })),
        syncRuns: syncResult.rows.map((row) => ({
          id: row.id, connectionId: row.connection_id, status: row.status,
          accountCount: row.account_count, observationCount: row.observation_count,
          versionCount: row.version_count, warningCount: row.provider_warning_count,
          errorCode: row.error_code, startedAt: row.started_at, completedAt: row.completed_at,
        })),
        observations,
        reconciliations: reconciliationResult.rows.map((row) => ({
          id: row.id, accountId: row.external_account_id,
          accountName: accountNames.get(row.external_account_id) ?? "Bank account",
          statementStartOn: row.statement_start_on, statementEndOn: row.statement_end_on,
          openingBalance: row.opening_balance, closingBalance: row.closing_balance,
          currencyCode: row.currency_code, status: row.status,
          createdAt: row.created_at, matchCount: row.match_count,
          voidReason: row.void_reason, voidedAt: row.voided_at,
        })),
        rules,
        proposalCount: proposalsResult.rows[0]?.count ?? 0,
        proposals,
        activeReconciliation,
      };
    } finally {
      activeKey?.dek.fill(0);
    }
  });
}
