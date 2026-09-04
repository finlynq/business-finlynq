import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./identity";

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
