import { check, foreignKey, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./identity";
import { legalEntities, ledgers } from "./ledger";

export const bookingBatches = pgTable("booking_batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  legalEntityId: uuid("legal_entity_id").notNull().references(() => legalEntities.id, { onDelete: "restrict" }),
  ledgerId: uuid("ledger_id").notNull().references(() => ledgers.id, { onDelete: "restrict" }),
  recordRefs: jsonb("record_refs").notNull(),
  requiredPermissions: text("required_permissions").array().notNull(),
  definitionCiphertext: text("definition_ciphertext").notNull(),
  keyVersion: integer("key_version").notNull(),
  commandHash: text("command_hash").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("booking_batches_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("booking_batches_org_idempotency_unique").on(table.organizationId, table.idempotencyKey),
  check("booking_batches_key_version_positive", sql`${table.keyVersion} > 0`),
  check("booking_batches_hash_check", sql`${table.commandHash} ~ '^[a-f0-9]{64}$'`),
  check("booking_batches_record_refs_check", sql`jsonb_typeof(${table.recordRefs}) = 'array' AND jsonb_array_length(${table.recordRefs}) BETWEEN 1 AND 100`),
]);

export const bookingBatchReports = pgTable("booking_batch_reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  batchId: uuid("batch_id").notNull(),
  version: integer("version").notNull(),
  phase: text("phase").notNull(),
  status: text("status").notNull(),
  completeness: text("completeness").notNull(),
  snapshotCiphertext: text("snapshot_ciphertext").notNull(),
  keyVersion: integer("key_version").notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
  commandHash: text("command_hash").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  reviewReportId: uuid("review_report_id"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.organizationId, table.batchId], foreignColumns: [bookingBatches.organizationId, bookingBatches.id], name: "booking_batch_reports_batch_fk" }).onDelete("restrict"),
  uniqueIndex("booking_batch_reports_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("booking_batch_reports_version_unique").on(table.organizationId, table.batchId, table.version),
  uniqueIndex("booking_batch_reports_org_idempotency_unique").on(table.organizationId, table.idempotencyKey),
  check("booking_batch_reports_version_positive", sql`${table.version} > 0 AND ${table.keyVersion} > 0`),
  check("booking_batch_reports_phase_check", sql`${table.phase} IN ('REVIEW','OUTCOME')`),
  check("booking_batch_reports_status_check", sql`${table.status} IN ('DRAFT','PARTIALLY_POSTED','POSTED')`),
  check("booking_batch_reports_completeness_check", sql`${table.completeness} IN ('COMPLETE','HELD','STALE')`),
  check("booking_batch_reports_hash_check", sql`${table.snapshotHash} ~ '^[a-f0-9]{64}$' AND ${table.commandHash} ~ '^[a-f0-9]{64}$'`),
]);
