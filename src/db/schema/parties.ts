import {
  boolean,
  date,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./identity";
import { glAccounts, legalEntities, ledgers } from "./ledger";

export const partyRoleKind = pgEnum("party_role_kind", ["CUSTOMER", "SUPPLIER"]);
export const openItemStatus = pgEnum("open_item_status", ["OPEN", "PARTIALLY_SETTLED", "SETTLED", "REVERSED"]);

export const parties = pgTable(
  "parties",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    partyNumber: text("party_number").notNull(),
    displayNameCiphertext: text("display_name_ciphertext").notNull(),
    searchToken: text("search_token").notNull(),
    internalLegalEntityId: uuid("internal_legal_entity_id").references(() => legalEntities.id, {
      onDelete: "restrict",
    }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("parties_org_number_unique").on(table.organizationId, table.partyNumber),
    uniqueIndex("parties_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const partyAddresses = pgTable(
  "party_addresses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    ciphertext: text("ciphertext").notNull(),
    keyVersion: text("key_version").notNull(),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("party_addresses_org_id_unique").on(table.organizationId, table.id)],
);

export const partyAccounts = pgTable(
  "party_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    legalEntityId: uuid("legal_entity_id")
      .notNull()
      .references(() => legalEntities.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "restrict" }),
    role: partyRoleKind("role").notNull(),
    accountNumber: text("account_number").notNull(),
    controlAccountId: uuid("control_account_id")
      .notNull()
      .references(() => glAccounts.id, { onDelete: "restrict" }),
    transactionCurrency: text("transaction_currency"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("party_accounts_entity_role_number_unique").on(
      table.legalEntityId,
      table.role,
      table.accountNumber,
    ),
    uniqueIndex("party_accounts_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const subledgerEvents = pgTable(
  "subledger_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),
    partyAccountId: uuid("party_account_id")
      .notNull()
      .references(() => partyAccounts.id, { onDelete: "restrict" }),
    sourceDocumentId: uuid("source_document_id").notNull(),
    eventType: text("event_type").notNull(),
    eventVersion: text("event_version").notNull(),
    eventAt: timestamp("event_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("subledger_events_org_id_unique").on(table.organizationId, table.id)],
);

export const openItems = pgTable(
  "open_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),
    partyAccountId: uuid("party_account_id")
      .notNull()
      .references(() => partyAccounts.id, { onDelete: "restrict" }),
    sourceEventId: uuid("source_event_id")
      .notNull()
      .references(() => subledgerEvents.id, { onDelete: "restrict" }),
    status: openItemStatus("status").notNull().default("OPEN"),
    transactionCurrency: text("transaction_currency").notNull(),
    originalTransactionAmount: numeric("original_transaction_amount", { precision: 38, scale: 9 }).notNull(),
    openTransactionAmount: numeric("open_transaction_amount", { precision: 38, scale: 9 }).notNull(),
    originalFunctionalAmount: numeric("original_functional_amount", { precision: 38, scale: 9 }).notNull(),
    carryingFunctionalAmount: numeric("carrying_functional_amount", { precision: 38, scale: 9 }).notNull(),
    dueOn: date("due_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("open_items_org_id_unique").on(table.organizationId, table.id)],
);
