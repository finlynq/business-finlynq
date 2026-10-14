import { date, foreignKey, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./identity";
import { journalEntries } from "./journals";
import { documentInboxItems } from "./document-storage";

export const documentEvidenceAssets = pgTable("document_evidence_assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  ownerModule: text("owner_module").notNull(),
  filenameCiphertext: text("filename_ciphertext").notNull(),
  contentCiphertext: text("content_ciphertext"),
  storageBackend: text("storage_backend").notNull().default("DATABASE"),
  storageConnectionId: uuid("storage_connection_id"),
  providerFileId: text("provider_file_id"),
  keyVersion: integer("key_version").notNull(),
  mimeType: text("mime_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  scannerVersion: text("scanner_version").notNull(),
  scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
  uploadedBy: uuid("uploaded_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  idempotencyKey: text("idempotency_key").notNull(),
  commandHash: text("command_hash").notNull(),
}, (table) => [
  uniqueIndex("document_evidence_assets_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("document_evidence_assets_org_idempotency_unique").on(table.organizationId, table.idempotencyKey),
]);

// Evidence amendments are separate from the immutable accounting journal.
// One original asset may support several posted journals without copying bytes.
export const journalEvidenceLinks = pgTable("journal_evidence_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  journalEntryId: uuid("journal_entry_id").notNull(),
  evidenceAssetId: uuid("evidence_asset_id").notNull(),
  sourceInboxItemId: uuid("source_inbox_item_id"),
  evidenceRevision: integer("evidence_revision").notNull(),
  journalContentHash: text("journal_content_hash").notNull(),
  documentDate: date("document_date").notNull(),
  documentReference: text("document_reference").notNull(),
  documentCurrency: text("document_currency").notNull(),
  documentTotal: numeric("document_total", { precision: 38, scale: 9 }).notNull(),
  reason: text("reason").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  commandHash: text("command_hash").notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.organizationId, table.journalEntryId], foreignColumns: [journalEntries.organizationId, journalEntries.id], name: "journal_evidence_links_org_journal_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.evidenceAssetId], foreignColumns: [documentEvidenceAssets.organizationId, documentEvidenceAssets.id], name: "journal_evidence_links_org_asset_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.organizationId, table.sourceInboxItemId], foreignColumns: [documentInboxItems.organizationId, documentInboxItems.id], name: "journal_evidence_links_org_inbox_fk" }).onDelete("restrict"),
  uniqueIndex("journal_evidence_links_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("journal_evidence_links_org_journal_asset_unique").on(table.organizationId, table.journalEntryId, table.evidenceAssetId),
  uniqueIndex("journal_evidence_links_org_journal_revision_unique").on(table.organizationId, table.journalEntryId, table.evidenceRevision),
  uniqueIndex("journal_evidence_links_org_idempotency_journal_unique").on(table.organizationId, table.idempotencyKey, table.journalEntryId),
]);
