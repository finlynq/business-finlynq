import { bigint, boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./identity";

export const documentStorageConnections = pgTable("document_storage_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  legalEntityId: uuid("legal_entity_id").notNull(), ownerModule: text("owner_module").notNull(),
  provider: text("provider").notNull(), label: text("label").notNull(),
  configCiphertext: text("config_ciphertext"), credentialsCiphertext: text("credentials_ciphertext"),
  keyVersion: integer("key_version").notNull(), active: boolean("active").notNull().default(false),
  createdBy: uuid("created_by").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }), syncCursor: text("sync_cursor"),
  oauthStateHash: text("oauth_state_hash"),
}, (table) => [uniqueIndex("document_storage_connections_org_id_unique").on(table.organizationId, table.id)]);

export const documentStorageOauth = pgTable("document_storage_oauth", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  connectionId: uuid("connection_id").notNull(), actorId: uuid("actor_id").notNull(), sessionId: uuid("session_id").notNull(),
  stateHash: text("state_hash").notNull(), verifierCiphertext: text("verifier_ciphertext").notNull(), keyVersion: integer("key_version").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (table) => [uniqueIndex("document_storage_oauth_state_unique").on(table.stateHash)]);

export const documentInboxItems = pgTable("document_inbox_items", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  connectionId: uuid("connection_id").notNull(), ownerModule: text("owner_module").notNull(),
  providerFileId: text("provider_file_id").notNull(), contentVersion: text("content_version").notNull(),
  metadataCiphertext: text("metadata_ciphertext").notNull(), keyVersion: integer("key_version").notNull(),
  mimeType: text("mime_type").notNull(), byteSize: bigint("byte_size", { mode: "number" }).notNull(),
  sha256: text("sha256"), status: text("status").notNull().default("PENDING"),
  claimId: uuid("claim_id"), claimedBy: uuid("claimed_by"), claimedSessionId: uuid("claimed_session_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  assetId: uuid("asset_id"), sourceDocumentId: uuid("source_document_id"),
  completionHash: text("completion_hash"), processingCiphertext: text("processing_ciphertext"),
  businessKey: text("business_key"),
  uploadKey: text("upload_key"), uploadHash: text("upload_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("document_inbox_items_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("document_inbox_items_file_unique").on(table.organizationId, table.connectionId, table.providerFileId),
  index("document_inbox_items_status_idx").on(table.organizationId, table.status, table.id),
  index("document_inbox_items_checksum_idx").on(table.organizationId, table.sha256),
  index("document_inbox_items_business_key_idx").on(table.organizationId, table.businessKey),
  uniqueIndex("document_inbox_items_upload_unique").on(table.organizationId, table.connectionId, table.uploadKey),
]);
