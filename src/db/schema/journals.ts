import {
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./identity";
import {
  accountCombinations,
  fiscalPeriods,
  legalEntities,
  ledgers,
} from "./ledger";
import { partyAccounts, subledgerEvents } from "./parties";

export const journalStatus = pgEnum("journal_status", [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "POSTED",
  "REVERSED",
]);
export const journalOrigin = pgEnum("journal_origin", ["USER", "SYSTEM", "IMPORT", "API", "MCP"]);
export const journalPurpose = pgEnum("journal_purpose", [
  "ROUTINE",
  "ADJUSTING",
  "REVERSAL",
  "OPENING",
  "CLOSING",
  "REVALUATION",
  "TAX_ADJUSTMENT",
]);
export const journalRelationKind = pgEnum("journal_relation_kind", [
  "REVERSAL_OF",
  "REPLACEMENT_OF",
  "REVERSES_ON_OPEN",
]);

export const journalTypeDefinitions = pgTable(
  "journal_type_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    ownerModule: text("owner_module").notNull(),
    displayName: text("display_name").notNull(),
    correctionRoute: text("correction_route").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("journal_type_key_version_unique").on(table.key, table.version)],
);

export const sourceDocuments = pgTable(
  "source_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    legalEntityId: uuid("legal_entity_id")
      .notNull()
      .references(() => legalEntities.id, { onDelete: "restrict" }),
    ownerModule: text("owner_module").notNull(),
    sourceType: text("source_type").notNull(),
    sourceNumber: text("source_number").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_documents_org_type_number_version_unique").on(
      table.organizationId,
      table.sourceType,
      table.sourceNumber,
      table.version,
    ),
    uniqueIndex("source_documents_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),
    legalEntityId: uuid("legal_entity_id")
      .notNull()
      .references(() => legalEntities.id, { onDelete: "restrict" }),
    periodId: uuid("period_id")
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: "restrict" }),
    journalTypeKey: text("journal_type_key")
      .notNull(),
    journalTypeDefinitionId: uuid("journal_type_definition_id")
      .notNull()
      .references(() => journalTypeDefinitions.id, { onDelete: "restrict" }),
    journalTypeVersion: integer("journal_type_version").notNull(),
    sourceDocumentId: uuid("source_document_id").references(() => sourceDocuments.id, {
      onDelete: "restrict",
    }),
    sourceEventKey: text("source_event_key").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    commandHash: text("command_hash").notNull().default("0000000000000000000000000000000000000000000000000000000000000000"),
    origin: journalOrigin("origin").notNull(),
    purpose: journalPurpose("purpose").notNull(),
    status: journalStatus("status").notNull().default("DRAFT"),
    accountingDate: date("accounting_date").notNull(),
    functionalCurrency: text("functional_currency").notNull(),
    journalNumber: integer("journal_number"),
    description: text("description").notNull(),
    totalDebitFunctional: numeric("total_debit_functional", { precision: 38, scale: 9 }).notNull().default("0"),
    totalCreditFunctional: numeric("total_credit_functional", { precision: 38, scale: 9 }).notNull().default("0"),
    contentHash: text("content_hash"),
    approvalVersion: integer("approval_version"),
    createdBy: uuid("created_by"),
    approvedBy: uuid("approved_by"),
    postedBy: uuid("posted_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("journal_entries_org_idempotency_unique").on(table.organizationId, table.idempotencyKey),
    uniqueIndex("journal_entries_ledger_number_unique").on(table.ledgerId, table.journalNumber),
    uniqueIndex("journal_entries_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const journalApprovals = pgTable(
  "journal_approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),
    journalEntryId: uuid("journal_entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "restrict" }),
    journalVersion: integer("journal_version").notNull(),
    contentHash: text("content_hash").notNull(),
    decision: text("decision").notNull(),
    actorId: uuid("actor_id").notNull(),
    reason: text("reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("journal_approvals_actor_version_unique").on(
      table.journalEntryId,
      table.journalVersion,
      table.actorId,
    ),
    uniqueIndex("journal_approvals_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),
    journalEntryId: uuid("journal_entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "restrict" }),
    lineNumber: integer("line_number").notNull(),
    accountCombinationId: uuid("account_combination_id")
      .notNull()
      .references(() => accountCombinations.id, { onDelete: "restrict" }),
    debitFunctional: numeric("debit_functional", { precision: 38, scale: 9 }).notNull().default("0"),
    creditFunctional: numeric("credit_functional", { precision: 38, scale: 9 }).notNull().default("0"),
    transactionCurrency: text("transaction_currency").notNull(),
    debitTransaction: numeric("debit_transaction", { precision: 38, scale: 9 }).notNull().default("0"),
    creditTransaction: numeric("credit_transaction", { precision: 38, scale: 9 }).notNull().default("0"),
    fxRate: numeric("fx_rate", { precision: 38, scale: 18 }).notNull(),
    fxRateSource: text("fx_rate_source").notNull(),
    fxRateEffectiveAt: timestamp("fx_rate_effective_at", { withTimezone: true }).notNull(),
    partyAccountId: uuid("party_account_id").references(() => partyAccounts.id, { onDelete: "restrict" }),
    subledgerEventId: uuid("subledger_event_id").references(() => subledgerEvents.id, {
      onDelete: "restrict",
    }),
    taxSnapshotId: uuid("tax_snapshot_id"),
    memo: text("memo"),
  },
  (table) => [
    uniqueIndex("journal_lines_entry_number_unique").on(table.journalEntryId, table.lineNumber),
    uniqueIndex("journal_lines_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const journalEntryRelations = pgTable(
  "journal_entry_relations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    fromJournalId: uuid("from_journal_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "restrict" }),
    toJournalId: uuid("to_journal_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "restrict" }),
    kind: journalRelationKind("kind").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("journal_entry_relations_unique").on(table.fromJournalId, table.toJournalId, table.kind),
  ],
);
