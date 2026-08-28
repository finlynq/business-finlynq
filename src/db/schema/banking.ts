import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./identity";
import { journalLines } from "./journals";
import {
  accountCombinations,
  currencyDefinitions,
  legalEntities,
  ledgers,
} from "./ledger";

export const bankConnections = pgTable(
  "bank_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    credentialsCiphertext: text("credentials_ciphertext").notNull(),
    credentialsKeyVersion: integer("credentials_key_version").notNull(),
    credentialVersion: integer("credential_version").notNull().default(1),
    status: text("status").notNull().default("ACTIVE"),
    idempotencyKey: text("idempotency_key").notNull(),
    commandHash: text("command_hash").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bank_connections_org_provider_unique").on(table.organizationId, table.provider),
    uniqueIndex("bank_connections_org_idempotency_unique").on(table.organizationId, table.idempotencyKey),
    uniqueIndex("bank_connections_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const bankConnectionCredentialEvents = pgTable(
  "bank_connection_credential_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    connectionId: uuid("connection_id").notNull().references(() => bankConnections.id, { onDelete: "restrict" }),
    credentialVersion: integer("credential_version").notNull(),
    eventType: text("event_type").notNull(),
    credentialCiphertextHash: text("credential_ciphertext_hash").notNull(),
    credentialKeyVersion: integer("credential_key_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    commandHash: text("command_hash").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bank_connection_credential_events_org_id_unique").on(table.organizationId, table.id),
    uniqueIndex("bank_connection_credential_events_connection_version_unique").on(table.connectionId, table.credentialVersion),
    uniqueIndex("bank_connection_credential_events_org_connection_version_unique").on(table.organizationId, table.connectionId, table.credentialVersion),
    uniqueIndex("bank_connection_credential_events_org_idempotency_unique").on(table.organizationId, table.idempotencyKey),
  ],
);

export const bankExternalAccounts = pgTable(
  "bank_external_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    connectionId: uuid("connection_id").notNull().references(() => bankConnections.id, { onDelete: "restrict" }),
    credentialVersion: integer("credential_version").notNull(),
    providerAccountIdHash: text("provider_account_id_hash").notNull(),
    providerAccountIdCiphertext: text("provider_account_id_ciphertext").notNull(),
    displayNameCiphertext: text("display_name_ciphertext").notNull(),
    keyVersion: integer("key_version").notNull(),
    currencyCode: text("currency_code").notNull().references(() => currencyDefinitions.code, { onDelete: "restrict" }),
    legalEntityId: uuid("legal_entity_id").references(() => legalEntities.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id").references(() => ledgers.id, { onDelete: "restrict" }),
    cashAccountCombinationId: uuid("cash_account_combination_id").references(() => accountCombinations.id, { onDelete: "restrict" }),
    active: boolean("active").notNull().default(true),
    lastReportedBalance: numeric("last_reported_balance", { precision: 38, scale: 9 }),
    lastBalanceAt: timestamp("last_balance_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bank_external_accounts_connection_identity_unique").on(table.connectionId, table.providerAccountIdHash),
    uniqueIndex("bank_external_accounts_org_id_unique").on(table.organizationId, table.id),
    uniqueIndex("bank_external_accounts_org_id_currency_unique").on(table.organizationId, table.id, table.currencyCode),
    uniqueIndex("bank_external_accounts_org_mapping_currency_unique").on(
      table.organizationId,
      table.id,
      table.legalEntityId,
      table.ledgerId,
      table.cashAccountCombinationId,
      table.currencyCode,
    ),
    index("bank_external_accounts_org_mapping_idx").on(table.organizationId, table.legalEntityId, table.active),
  ],
);

export const bankSyncRuns = pgTable(
  "bank_sync_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    connectionId: uuid("connection_id").notNull().references(() => bankConnections.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("RUNNING"),
    requestedStartOn: date("requested_start_on"),
    requestedEndOn: date("requested_end_on"),
    accountCount: integer("account_count").notNull().default(0),
    observationCount: integer("observation_count").notNull().default(0),
    versionCount: integer("version_count").notNull().default(0),
    providerWarningCount: integer("provider_warning_count").notNull().default(0),
    errorCode: text("error_code"),
    createdBy: uuid("created_by").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("bank_sync_runs_org_id_unique").on(table.organizationId, table.id),
    index("bank_sync_runs_connection_started_idx").on(table.connectionId, table.startedAt),
  ],
);

export const bankObservations = pgTable(
  "bank_observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    externalAccountId: uuid("external_account_id").notNull().references(() => bankExternalAccounts.id, { onDelete: "restrict" }),
    providerTransactionIdHash: text("provider_transaction_id_hash").notNull(),
    providerTransactionIdCiphertext: text("provider_transaction_id_ciphertext").notNull(),
    keyVersion: integer("key_version").notNull(),
    firstSeenRunId: uuid("first_seen_run_id").notNull().references(() => bankSyncRuns.id, { onDelete: "restrict" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bank_observations_account_transaction_unique").on(table.externalAccountId, table.providerTransactionIdHash),
    uniqueIndex("bank_observations_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const bankObservationVersions = pgTable(
  "bank_observation_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    observationId: uuid("observation_id").notNull().references(() => bankObservations.id, { onDelete: "restrict" }),
    syncRunId: uuid("sync_run_id").notNull().references(() => bankSyncRuns.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    contentHash: text("content_hash").notNull(),
    status: text("status").notNull(),
    postedOn: date("posted_on").notNull(),
    transactedAt: timestamp("transacted_at", { withTimezone: true }),
    amount: numeric("amount", { precision: 38, scale: 9 }).notNull(),
    currencyCode: text("currency_code").notNull().references(() => currencyDefinitions.code, { onDelete: "restrict" }),
    detailsCiphertext: text("details_ciphertext").notNull(),
    keyVersion: integer("key_version").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bank_observation_versions_number_unique").on(table.observationId, table.versionNumber),
    uniqueIndex("bank_observation_versions_content_unique").on(table.observationId, table.contentHash),
    uniqueIndex("bank_observation_versions_org_id_unique").on(table.organizationId, table.id),
    index("bank_observation_versions_org_posted_idx").on(table.organizationId, table.postedOn),
  ],
);

export const bankBalanceAnchors = pgTable(
  "bank_balance_anchors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    externalAccountId: uuid("external_account_id").notNull().references(() => bankExternalAccounts.id, { onDelete: "restrict" }),
    syncRunId: uuid("sync_run_id").notNull().references(() => bankSyncRuns.id, { onDelete: "restrict" }),
    balance: numeric("balance", { precision: 38, scale: 9 }).notNull(),
    availableBalance: numeric("available_balance", { precision: 38, scale: 9 }),
    currencyCode: text("currency_code").notNull().references(() => currencyDefinitions.code, { onDelete: "restrict" }),
    balanceAt: timestamp("balance_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bank_balance_anchors_account_run_unique").on(table.externalAccountId, table.syncRunId),
    uniqueIndex("bank_balance_anchors_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const bankReconciliationSessions = pgTable(
  "bank_reconciliation_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    externalAccountId: uuid("external_account_id").notNull().references(() => bankExternalAccounts.id, { onDelete: "restrict" }),
    legalEntityId: uuid("legal_entity_id").notNull().references(() => legalEntities.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id").notNull().references(() => ledgers.id, { onDelete: "restrict" }),
    cashAccountCombinationId: uuid("cash_account_combination_id").notNull().references(() => accountCombinations.id, { onDelete: "restrict" }),
    statementStartOn: date("statement_start_on").notNull(),
    statementEndOn: date("statement_end_on").notNull(),
    openingBalance: numeric("opening_balance", { precision: 38, scale: 9 }).notNull(),
    closingBalance: numeric("closing_balance", { precision: 38, scale: 9 }).notNull(),
    currencyCode: text("currency_code").notNull().references(() => currencyDefinitions.code, { onDelete: "restrict" }),
    status: text("status").notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull(),
    commandHash: text("command_hash").notNull(),
    createdBy: uuid("created_by").notNull(),
    submittedBy: uuid("submitted_by"),
    reviewedBy: uuid("reviewed_by"),
    finalizedBy: uuid("finalized_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedObservationTotal: numeric("finalized_observation_total", { precision: 38, scale: 9 }),
    finalizedLedgerTotal: numeric("finalized_ledger_total", { precision: 38, scale: 9 }),
    finalizedUnexplainedDifference: numeric("finalized_unexplained_difference", { precision: 38, scale: 9 }),
    finalizedMatchHash: text("finalized_match_hash"),
  },
  (table) => [
    uniqueIndex("bank_reconciliation_sessions_org_id_unique").on(table.organizationId, table.id),
    uniqueIndex("bank_reconciliation_sessions_org_idempotency_unique").on(table.organizationId, table.idempotencyKey),
    uniqueIndex("bank_reconciliation_sessions_active_account_period_unique")
      .on(table.externalAccountId, table.statementStartOn, table.statementEndOn)
      .where(sql`${table.status} <> 'VOIDED'`),
  ],
);

export const bankMatchAllocations = pgTable(
  "bank_match_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    reconciliationSessionId: uuid("reconciliation_session_id").notNull().references(() => bankReconciliationSessions.id, { onDelete: "restrict" }),
    observationVersionId: uuid("observation_version_id").notNull().references(() => bankObservationVersions.id, { onDelete: "restrict" }),
    journalLineId: uuid("journal_line_id").notNull().references(() => journalLines.id, { onDelete: "restrict" }),
    matchKind: text("match_kind").notNull(),
    allocatedAmount: numeric("allocated_amount", { precision: 38, scale: 9 }).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bank_match_allocations_org_id_unique").on(table.organizationId, table.id),
    index("bank_match_allocations_session_idx").on(table.reconciliationSessionId, table.createdAt),
  ],
);

export const bankReconciliationVoids = pgTable(
  "bank_reconciliation_voids",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    reconciliationSessionId: uuid("reconciliation_session_id").notNull().references(() => bankReconciliationSessions.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bank_reconciliation_voids_session_unique").on(table.reconciliationSessionId),
    uniqueIndex("bank_reconciliation_voids_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const bankMatchAllocationVoids = pgTable(
  "bank_match_allocation_voids",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    allocationId: uuid("allocation_id").notNull().references(() => bankMatchAllocations.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bank_match_allocation_voids_allocation_unique").on(table.allocationId),
    uniqueIndex("bank_match_allocation_voids_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const bankRules = pgTable(
  "bank_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    priority: integer("priority").notNull().default(100),
    state: text("state").notNull().default("DRAFT"),
    conditionCiphertext: text("condition_ciphertext").notNull(),
    actionCiphertext: text("action_ciphertext").notNull(),
    keyVersion: integer("key_version").notNull(),
    version: integer("version").notNull().default(1),
    supersedesRuleId: uuid("supersedes_rule_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    commandHash: text("command_hash").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bank_rules_org_name_version_unique").on(table.organizationId, table.name, table.version),
    uniqueIndex("bank_rules_org_idempotency_unique").on(table.organizationId, table.idempotencyKey),
    uniqueIndex("bank_rules_org_id_unique").on(table.organizationId, table.id),
    uniqueIndex("bank_rules_org_supersedes_unique").on(table.organizationId, table.supersedesRuleId),
    index("bank_rules_org_state_priority_idx").on(table.organizationId, table.state, table.priority),
  ],
);

export const bankRuleRuns = pgTable(
  "bank_rule_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    syncRunId: uuid("sync_run_id").notNull().references(() => bankSyncRuns.id, { onDelete: "restrict" }),
    observationVersionId: uuid("observation_version_id").notNull().references(() => bankObservationVersions.id, { onDelete: "restrict" }),
    ruleId: uuid("rule_id").notNull().references(() => bankRules.id, { onDelete: "restrict" }),
    matched: boolean("matched").notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bank_rule_runs_evaluation_unique").on(table.syncRunId, table.observationVersionId, table.ruleId),
    uniqueIndex("bank_rule_runs_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const bankDraftProposals = pgTable(
  "bank_draft_proposals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    observationVersionId: uuid("observation_version_id").notNull().references(() => bankObservationVersions.id, { onDelete: "restrict" }),
    ruleId: uuid("rule_id").references(() => bankRules.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    payloadCiphertext: text("payload_ciphertext").notNull(),
    payloadHash: text("payload_hash").notNull(),
    keyVersion: integer("key_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bank_draft_proposals_identity_unique").on(table.observationVersionId, table.ruleId, table.payloadHash),
    uniqueIndex("bank_draft_proposals_org_id_unique").on(table.organizationId, table.id),
    index("bank_draft_proposals_org_created_idx").on(table.organizationId, table.createdAt),
  ],
);
