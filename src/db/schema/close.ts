import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./identity";
import { fiscalPeriods, legalEntities, ledgers } from "./ledger";
function audit() { return { id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }), reason: text("reason").notNull(), idempotencyKey: text("idempotency_key").notNull(), commandHash: text("command_hash").notNull(), createdBy: uuid("created_by").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow() }; }
export const closeTemplateRevisions = pgTable("close_template_revisions", { ...audit(), templateId: uuid("template_id").notNull(), version: integer("version").notNull(), definition: jsonb("definition").notNull() }, table => [
    uniqueIndex("close_templates_org_id").on(table.organizationId, table.id), uniqueIndex("close_templates_version").on(table.organizationId, table.templateId, table.version), uniqueIndex("close_templates_replay").on(table.organizationId, table.idempotencyKey),
    check("close_templates_valid", sql `${table.version}>0 AND jsonb_typeof(${table.definition})='object' AND ${table.commandHash}~'^[a-f0-9]{64}$' AND length(${table.reason}) BETWEEN 8 AND 500`),
]);
export const closeInstances = pgTable("close_instances", { ...audit(), legalEntityId: uuid("legal_entity_id").notNull(), ledgerId: uuid("ledger_id").notNull(), periodId: uuid("period_id").notNull(), templateRevisionId: uuid("template_revision_id").notNull(), taskDefinitions: jsonb("task_definitions").notNull() }, table => [
    uniqueIndex("close_instances_org_id").on(table.organizationId, table.id), uniqueIndex("close_instances_period").on(table.organizationId, table.periodId), uniqueIndex("close_instances_replay").on(table.organizationId, table.idempotencyKey),
    foreignKey({ columns: [table.organizationId, table.legalEntityId], foreignColumns: [legalEntities.organizationId, legalEntities.id], name: "close_instances_entity_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.organizationId, table.ledgerId], foreignColumns: [ledgers.organizationId, ledgers.id], name: "close_instances_ledger_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.organizationId, table.periodId], foreignColumns: [fiscalPeriods.organizationId, fiscalPeriods.id], name: "close_instances_period_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.organizationId, table.templateRevisionId], foreignColumns: [closeTemplateRevisions.organizationId, closeTemplateRevisions.id], name: "close_instances_template_fk" }).onDelete("restrict"),
    check("close_instances_valid", sql `jsonb_typeof(${table.taskDefinitions})='array' AND ${table.commandHash}~'^[a-f0-9]{64}$' AND length(${table.reason}) BETWEEN 8 AND 500`),
]);
export const closeTaskRevisions = pgTable("close_task_revisions", { ...audit(), instanceId: uuid("instance_id").notNull(), taskKey: text("task_key").notNull(), version: integer("version").notNull(), definition: jsonb("definition").notNull(), input: jsonb("input").notNull(), review: jsonb("review"), sourceHash: text("source_hash"), carriedFromRevisionId: uuid("carried_from_revision_id") }, table => [
    uniqueIndex("close_tasks_org_id").on(table.organizationId, table.id), uniqueIndex("close_tasks_version").on(table.organizationId, table.instanceId, table.taskKey, table.version), uniqueIndex("close_tasks_replay").on(table.organizationId, table.idempotencyKey),
    foreignKey({ columns: [table.organizationId, table.instanceId], foreignColumns: [closeInstances.organizationId, closeInstances.id], name: "close_tasks_instance_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.organizationId, table.carriedFromRevisionId], foreignColumns: [table.organizationId, table.id], name: "close_tasks_origin_fk" }).onDelete("restrict"),
    check("close_tasks_valid", sql `${table.version}>0 AND length(${table.taskKey}) BETWEEN 1 AND 180 AND jsonb_typeof(${table.definition})='object' AND jsonb_typeof(${table.input})='object' AND ${table.commandHash}~'^[a-f0-9]{64}$' AND length(${table.reason}) BETWEEN 8 AND 500`),
    check("close_tasks_review", sql `(${table.sourceHash} IS NULL OR ${table.sourceHash}~'^[a-f0-9]{64}$') AND (${table.input}->>'status' NOT IN ('REVIEWED','COMPLETE','NOT_APPLICABLE') OR (${table.review} IS NOT NULL AND ${table.sourceHash} IS NOT NULL))`),
]);
export const closeNotificationPreferences = pgTable("close_notification_preferences", { ...audit(), instanceId: uuid("instance_id").notNull(), recipientId: uuid("recipient_id").notNull(), version: integer("version").notNull(), enabled: boolean("enabled").notNull().default(false), dueWithinDays: integer("due_within_days").notNull(), events: jsonb("events").notNull() }, table => [
    uniqueIndex("close_notifications_version").on(table.organizationId, table.instanceId, table.recipientId, table.version), uniqueIndex("close_notifications_replay").on(table.organizationId, table.idempotencyKey),
    foreignKey({ columns: [table.organizationId, table.instanceId], foreignColumns: [closeInstances.organizationId, closeInstances.id], name: "close_notifications_instance_fk" }).onDelete("restrict"),
    check("close_notifications_valid", sql `${table.version}>0 AND ${table.dueWithinDays} BETWEEN 0 AND 30 AND jsonb_typeof(${table.events})='array' AND ${table.commandHash}~'^[a-f0-9]{64}$' AND length(${table.reason}) BETWEEN 8 AND 500`),
]);
export const closeNotificationReceipts = pgTable("close_notification_receipts", { ...audit(), instanceId: uuid("instance_id").notNull(), recipientId: uuid("recipient_id").notNull(), noticeKey: text("notice_key").notNull(), asOfDate: date("as_of_date").notNull() }, table => [
    uniqueIndex("close_receipts_notice").on(table.organizationId, table.recipientId, table.noticeKey), uniqueIndex("close_receipts_replay").on(table.organizationId, table.idempotencyKey),
    foreignKey({ columns: [table.organizationId, table.instanceId], foreignColumns: [closeInstances.organizationId, closeInstances.id], name: "close_receipts_instance_fk" }).onDelete("restrict"),
    check("close_receipts_valid", sql `${table.noticeKey}~'^[a-f0-9]{64}$' AND ${table.commandHash}~'^[a-f0-9]{64}$' AND length(${table.reason}) BETWEEN 8 AND 500`),
]);
