import { sql } from "drizzle-orm";
import { check, date, foreignKey, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./identity";
import { legalEntities, ledgers, fiscalPeriods } from "./ledger";
import { journalEntries } from "./journals";
export const taxProvisionAssumptions = pgTable("tax_provision_assumptions", {
    id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    legalEntityId: uuid("legal_entity_id").notNull(), ledgerId: uuid("ledger_id").notNull(), fiscalYear: integer("fiscal_year").notNull(),
    yearStart: date("year_start").notNull(), yearEnd: date("year_end").notNull(), version: integer("version").notNull(), state: text("state").notNull(),
    payload: jsonb("payload").notNull(), supersedesId: uuid("supersedes_id"), reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(), commandHash: text("command_hash").notNull(), createdBy: uuid("created_by").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
    uniqueIndex("tax_provision_assumptions_org_id").on(table.organizationId, table.id),
    uniqueIndex("tax_provision_assumptions_scope_version").on(table.organizationId, table.ledgerId, table.fiscalYear, table.version),
    uniqueIndex("tax_provision_assumptions_replay").on(table.organizationId, table.idempotencyKey),
    foreignKey({ columns: [table.organizationId, table.legalEntityId], foreignColumns: [legalEntities.organizationId, legalEntities.id], name: "tax_provision_assumptions_entity_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.organizationId, table.ledgerId], foreignColumns: [ledgers.organizationId, ledgers.id], name: "tax_provision_assumptions_ledger_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.organizationId, table.supersedesId], foreignColumns: [table.organizationId, table.id], name: "tax_provision_assumptions_prior_fk" }).onDelete("restrict"),
    check("tax_provision_assumptions_scope_check", sql `${table.fiscalYear} BETWEEN 1900 AND 2500 AND ${table.version}>0 AND ${table.yearStart}<=${table.yearEnd} AND ${table.yearEnd}-${table.yearStart}<367`),
    check("tax_provision_assumptions_state_check", sql `${table.state} IN ('DRAFT','REVIEWED')`),
    check("tax_provision_assumptions_payload_check", sql `jsonb_typeof(${table.payload})='object' AND length(${table.reason}) BETWEEN 8 AND 500`),
    check("tax_provision_assumptions_hash_check", sql `${table.commandHash} ~ '^[a-f0-9]{64}$'`),
]);
export const taxProvisionCalculations = pgTable("tax_provision_calculations", {
    id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    legalEntityId: uuid("legal_entity_id").notNull(), ledgerId: uuid("ledger_id").notNull(), periodId: uuid("period_id").notNull(),
    assumptionsId: uuid("assumptions_id").notNull(), fiscalYear: integer("fiscal_year").notNull(), throughDate: date("through_date").notNull(), version: integer("version").notNull(),
    snapshot: jsonb("snapshot").notNull(), sourceHash: text("source_hash").notNull(), reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(), commandHash: text("command_hash").notNull(), createdBy: uuid("created_by").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
    uniqueIndex("tax_provision_calculations_org_id").on(table.organizationId, table.id),
    uniqueIndex("tax_provision_calculations_scope_version").on(table.organizationId, table.ledgerId, table.throughDate, table.version),
    uniqueIndex("tax_provision_calculations_source").on(table.organizationId, table.sourceHash),
    uniqueIndex("tax_provision_calculations_replay").on(table.organizationId, table.idempotencyKey),
    foreignKey({ columns: [table.organizationId, table.assumptionsId], foreignColumns: [taxProvisionAssumptions.organizationId, taxProvisionAssumptions.id], name: "tax_provision_calculations_assumptions_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.organizationId, table.periodId], foreignColumns: [fiscalPeriods.organizationId, fiscalPeriods.id], name: "tax_provision_calculations_period_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.organizationId, table.ledgerId], foreignColumns: [ledgers.organizationId, ledgers.id], name: "tax_provision_calculations_ledger_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.organizationId, table.legalEntityId], foreignColumns: [legalEntities.organizationId, legalEntities.id], name: "tax_provision_calculations_entity_fk" }).onDelete("restrict"),
    check("tax_provision_calculations_snapshot_check", sql `jsonb_typeof(${table.snapshot})='object' AND ${table.version}>0 AND length(${table.reason}) BETWEEN 8 AND 500`),
    check("tax_provision_calculations_hash_check", sql `${table.commandHash} ~ '^[a-f0-9]{64}$' AND ${table.sourceHash} ~ '^[a-f0-9]{64}$'`),
]);
export const taxProvisionEvents = pgTable("tax_provision_events", {
    id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    calculationId: uuid("calculation_id").notNull(), version: integer("version").notNull(), action: text("action").notNull(), journalId: uuid("journal_id"),
    sourceHash: text("source_hash").notNull(), reason: text("reason").notNull(), idempotencyKey: text("idempotency_key").notNull(), commandHash: text("command_hash").notNull(),
    createdBy: uuid("created_by").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
    uniqueIndex("tax_provision_events_version").on(table.organizationId, table.calculationId, table.version),
    uniqueIndex("tax_provision_events_replay").on(table.organizationId, table.idempotencyKey),
    uniqueIndex("tax_provision_events_one_draft").on(table.organizationId, table.calculationId).where(sql `${table.action}='DRAFT'`),
    foreignKey({ columns: [table.organizationId, table.calculationId], foreignColumns: [taxProvisionCalculations.organizationId, taxProvisionCalculations.id], name: "tax_provision_events_calculation_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.organizationId, table.journalId], foreignColumns: [journalEntries.organizationId, journalEntries.id], name: "tax_provision_events_journal_fk" }).onDelete("restrict"),
    check("tax_provision_events_state_check", sql `${table.action} IN ('REVIEW','DRAFT') AND ${table.version}>0 AND (${table.action}<>'REVIEW' OR ${table.journalId} IS NULL)`),
    check("tax_provision_events_hash_check", sql `${table.commandHash} ~ '^[a-f0-9]{64}$' AND ${table.sourceHash} ~ '^[a-f0-9]{64}$' AND length(${table.reason}) BETWEEN 8 AND 500`),
]);
