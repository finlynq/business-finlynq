import {
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { documentInboxItems } from "./document-storage";
import { documentEvidenceAssets } from "./evidence";
import { organizations } from "./identity";
import { sourceDocuments } from "./journals";
import { legalEntities } from "./ledger";
import { partyAccounts } from "./parties";

export const emailIngestionAliases = pgTable("email_ingestion_aliases", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  legalEntityId: uuid("legal_entity_id"),
  connectionId: uuid("connection_id"),
  provider: text("provider").notNull().default("RESEND"),
  label: text("label").notNull(),
  purpose: text("purpose").notNull().default("PAYABLES"),
  addressDigest: text("address_digest").notNull(),
  addressCiphertext: text("address_ciphertext").notNull(),
  keyVersion: integer("key_version").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  version: integer("version").notNull().default(1),
  hourlyLimit: integer("hourly_limit").notNull().default(25),
  maxPayloadBytes: integer("max_payload_bytes").notNull().default(10 * 1024 * 1024),
  idempotencyKey: text("idempotency_key").notNull(),
  commandHash: text("command_hash").notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("email_ingestion_aliases_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("email_ingestion_aliases_address_unique").on(table.addressDigest),
  uniqueIndex("email_ingestion_aliases_idempotency_unique").on(table.organizationId, table.idempotencyKey),
  index("email_ingestion_aliases_org_status_idx").on(table.organizationId, table.status, table.id),
  foreignKey({
    columns: [table.organizationId, table.legalEntityId],
    foreignColumns: [legalEntities.organizationId, legalEntities.id],
    name: "email_ingestion_aliases_tenant_entity_fk",
  }).onDelete("restrict"),
]);

export const inboundEmailMessages = pgTable("inbound_email_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  aliasId: uuid("alias_id").notNull(),
  provider: text("provider").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  providerMessageId: text("provider_message_id").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  senderAuth: jsonb("sender_auth").$type<Record<string, unknown>>().notNull().default({}),
  envelopeCiphertext: text("envelope_ciphertext"),
  keyVersion: integer("key_version").notNull(),
  routingResult: text("routing_result").notNull(),
  status: text("status").notNull().default("RECEIVED"),
  retryCount: integer("retry_count").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  errorCode: text("error_code"),
  transientExpiresAt: timestamp("transient_expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("inbound_email_messages_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("inbound_email_messages_event_alias_unique").on(table.provider, table.providerEventId, table.aliasId),
  uniqueIndex("inbound_email_messages_message_alias_unique").on(table.provider, table.providerMessageId, table.aliasId),
  index("inbound_email_messages_ops_idx").on(table.organizationId, table.status, table.nextRetryAt, table.id),
  foreignKey({
    columns: [table.organizationId, table.aliasId],
    foreignColumns: [emailIngestionAliases.organizationId, emailIngestionAliases.id],
    name: "inbound_email_messages_tenant_alias_fk",
  }).onDelete("restrict"),
]);

export const inboundEmailAttachments = pgTable("inbound_email_attachments", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  messageId: uuid("message_id").notNull(),
  attachmentKey: text("attachment_key").notNull(),
  filenameCiphertext: text("filename_ciphertext").notNull(),
  contentCiphertext: text("content_ciphertext"),
  keyVersion: integer("key_version").notNull(),
  mimeType: text("mime_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  pageCount: integer("page_count"),
  evidencePurpose: text("evidence_purpose").notNull().default("INVOICE"),
  status: text("status").notNull().default("STAGED"),
  quarantineCode: text("quarantine_code"),
  inboxItemId: uuid("inbox_item_id"),
  evidenceAssetId: uuid("evidence_asset_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("inbound_email_attachments_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("inbound_email_attachments_message_key_unique").on(table.messageId, table.attachmentKey),
  index("inbound_email_attachments_checksum_idx").on(table.organizationId, table.sha256),
  index("inbound_email_attachments_ops_idx").on(table.organizationId, table.status, table.id),
  foreignKey({
    columns: [table.organizationId, table.messageId],
    foreignColumns: [inboundEmailMessages.organizationId, inboundEmailMessages.id],
    name: "inbound_email_attachments_tenant_message_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.organizationId, table.inboxItemId],
    foreignColumns: [documentInboxItems.organizationId, documentInboxItems.id],
    name: "inbound_email_attachments_tenant_inbox_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.organizationId, table.evidenceAssetId],
    foreignColumns: [documentEvidenceAssets.organizationId, documentEvidenceAssets.id],
    name: "inbound_email_attachments_tenant_evidence_fk",
  }).onDelete("restrict"),
]);

export const emailBookingRules = pgTable("email_booking_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  version: integer("version").notNull(),
  priority: integer("priority").notNull().default(100),
  active: boolean("active").notNull().default(true),
  mode: text("mode").notNull().default("REVIEW_ONLY"),
  conditions: jsonb("conditions").$type<Record<string, unknown>>().notNull(),
  action: jsonb("action").$type<Record<string, unknown>>().notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  commandHash: text("command_hash").notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("email_booking_rules_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("email_booking_rules_name_version_unique").on(table.organizationId, table.name, table.version),
  uniqueIndex("email_booking_rules_idempotency_unique").on(table.organizationId, table.idempotencyKey),
  index("email_booking_rules_active_idx").on(table.organizationId, table.active, table.priority, table.id),
]);

export const emailDeliverySettings = pgTable("email_delivery_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  version: integer("version").notNull().default(1),
  outboundEnabled: boolean("outbound_enabled").notNull().default(false),
  autoSendEnabled: boolean("auto_send_enabled").notNull().default(false),
  transientRetentionDays: integer("transient_retention_days").notNull().default(30),
  quarantineRetentionDays: integer("quarantine_retention_days").notNull().default(30),
  operationRetentionDays: integer("operation_retention_days").notNull().default(90),
  updatedBy: uuid("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("email_delivery_settings_org_unique").on(table.organizationId),
  uniqueIndex("email_delivery_settings_org_id_unique").on(table.organizationId, table.id),
]);

export const emailBookingEvaluations = pgTable("email_booking_evaluations", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  inboxItemId: uuid("inbox_item_id").notNull(),
  messageId: uuid("message_id").notNull(),
  ruleId: uuid("rule_id"),
  ruleVersion: integer("rule_version"),
  factsCiphertext: text("facts_ciphertext").notNull(),
  keyVersion: integer("key_version").notNull(),
  outcome: text("outcome").notNull(),
  reason: text("reason").notNull(),
  sourceDocumentId: uuid("source_document_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  commandHash: text("command_hash").notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("email_booking_evaluations_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("email_booking_evaluations_idempotency_unique").on(table.organizationId, table.idempotencyKey),
  index("email_booking_evaluations_inbox_idx").on(table.organizationId, table.inboxItemId, table.createdAt),
  foreignKey({
    columns: [table.organizationId, table.inboxItemId],
    foreignColumns: [documentInboxItems.organizationId, documentInboxItems.id],
    name: "email_booking_evaluations_tenant_inbox_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.organizationId, table.messageId],
    foreignColumns: [inboundEmailMessages.organizationId, inboundEmailMessages.id],
    name: "email_booking_evaluations_tenant_message_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.organizationId, table.ruleId],
    foreignColumns: [emailBookingRules.organizationId, emailBookingRules.id],
    name: "email_booking_evaluations_tenant_rule_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.organizationId, table.sourceDocumentId],
    foreignColumns: [sourceDocuments.organizationId, sourceDocuments.id],
    name: "email_booking_evaluations_tenant_source_fk",
  }).onDelete("restrict"),
]);

export const paymentInstructionProfiles = pgTable("payment_instruction_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  legalEntityId: uuid("legal_entity_id").notNull(),
  currencyCode: text("currency_code").notNull(),
  name: text("name").notNull(),
  version: integer("version").notNull(),
  active: boolean("active").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  detailsCiphertext: text("details_ciphertext").notNull(),
  maskedSummary: jsonb("masked_summary").$type<Record<string, unknown>>().notNull(),
  keyVersion: integer("key_version").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  idempotencyKey: text("idempotency_key").notNull(),
  commandHash: text("command_hash").notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("payment_instruction_profiles_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("payment_instruction_profiles_name_version_unique").on(table.organizationId, table.legalEntityId, table.currencyCode, table.name, table.version),
  uniqueIndex("payment_instruction_profiles_idempotency_unique").on(table.organizationId, table.idempotencyKey),
  index("payment_instruction_profiles_lookup_idx").on(table.organizationId, table.legalEntityId, table.currencyCode, table.active),
  foreignKey({
    columns: [table.organizationId, table.legalEntityId],
    foreignColumns: [legalEntities.organizationId, legalEntities.id],
    name: "payment_instruction_profiles_tenant_entity_fk",
  }).onDelete("restrict"),
]);

export const customerDeliveryPreferences = pgTable("customer_delivery_preferences", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  partyAccountId: uuid("party_account_id").notNull(),
  version: integer("version").notNull().default(1),
  preferencesCiphertext: text("preferences_ciphertext").notNull(),
  keyVersion: integer("key_version").notNull(),
  deliveryMethod: text("delivery_method").notNull().default("EMAIL"),
  autoSendOnIssue: boolean("auto_send_on_issue").notNull().default(false),
  paymentProfileId: uuid("payment_profile_id"),
  suppressionStatus: text("suppression_status").notNull().default("NONE"),
  updatedBy: uuid("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("customer_delivery_preferences_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("customer_delivery_preferences_account_unique").on(table.organizationId, table.partyAccountId),
  foreignKey({
    columns: [table.organizationId, table.partyAccountId],
    foreignColumns: [partyAccounts.organizationId, partyAccounts.id],
    name: "customer_delivery_preferences_tenant_account_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.organizationId, table.paymentProfileId],
    foreignColumns: [paymentInstructionProfiles.organizationId, paymentInstructionProfiles.id],
    name: "customer_delivery_preferences_tenant_profile_fk",
  }).onDelete("restrict"),
]);

export const salesInvoicePdfArtifacts = pgTable("sales_invoice_pdf_artifacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  sourceDocumentId: uuid("source_document_id").notNull(),
  sourceVersion: integer("source_version").notNull(),
  sourceContentHash: text("source_content_hash").notNull(),
  templateVersion: text("template_version").notNull(),
  paymentProfileId: uuid("payment_profile_id"),
  paymentProfileVersion: integer("payment_profile_version"),
  assetId: uuid("asset_id").notNull(),
  preview: boolean("preview").notNull().default(false),
  sha256: text("sha256").notNull(),
  renderFacts: jsonb("render_facts").$type<Record<string, unknown>>().notNull(),
  renderFactsCiphertext: text("render_facts_ciphertext").notNull(),
  keyVersion: integer("key_version").notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sales_invoice_pdf_artifacts_org_id_unique").on(table.organizationId, table.id),
  unique("sales_invoice_pdf_artifacts_source_unique")
    .on(table.organizationId, table.sourceDocumentId, table.sourceVersion, table.sourceContentHash,
      table.templateVersion, table.preview, table.paymentProfileId)
    .nullsNotDistinct(),
  foreignKey({
    columns: [table.organizationId, table.sourceDocumentId],
    foreignColumns: [sourceDocuments.organizationId, sourceDocuments.id],
    name: "sales_invoice_pdf_artifacts_tenant_source_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.organizationId, table.assetId],
    foreignColumns: [documentEvidenceAssets.organizationId, documentEvidenceAssets.id],
    name: "sales_invoice_pdf_artifacts_tenant_asset_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.organizationId, table.paymentProfileId],
    foreignColumns: [paymentInstructionProfiles.organizationId, paymentInstructionProfiles.id],
    name: "sales_invoice_pdf_artifacts_tenant_profile_fk",
  }).onDelete("restrict"),
]);

export const invoiceDeliveryAttempts = pgTable("invoice_delivery_attempts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  sourceDocumentId: uuid("source_document_id").notNull(),
  sourceVersion: integer("source_version").notNull(),
  sourceContentHash: text("source_content_hash").notNull(),
  pdfArtifactId: uuid("pdf_artifact_id").notNull(),
  provider: text("provider").notNull().default("RESEND"),
  providerMessageId: text("provider_message_id"),
  recipientsCiphertext: text("recipients_ciphertext").notNull(),
  keyVersion: integer("key_version").notNull(),
  templateVersion: text("template_version").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  commandHash: text("command_hash").notNull(),
  status: text("status").notNull().default("QUEUED"),
  failureCode: text("failure_code"),
  retryCount: integer("retry_count").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  manualResend: boolean("manual_resend").notNull().default(false),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("invoice_delivery_attempts_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("invoice_delivery_attempts_idempotency_unique").on(table.organizationId, table.idempotencyKey),
  index("invoice_delivery_attempts_source_idx").on(table.organizationId, table.sourceDocumentId, table.createdAt),
  index("invoice_delivery_attempts_ops_idx").on(table.organizationId, table.status, table.nextRetryAt, table.id),
  foreignKey({
    columns: [table.organizationId, table.sourceDocumentId],
    foreignColumns: [sourceDocuments.organizationId, sourceDocuments.id],
    name: "invoice_delivery_attempts_tenant_source_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.organizationId, table.pdfArtifactId],
    foreignColumns: [salesInvoicePdfArtifacts.organizationId, salesInvoicePdfArtifacts.id],
    name: "invoice_delivery_attempts_tenant_pdf_fk",
  }).onDelete("restrict"),
]);

export const invoiceDeliveryEvents = pgTable("invoice_delivery_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  attemptId: uuid("attempt_id").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  eventType: text("event_type").notNull(),
  eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
  payloadSummary: jsonb("payload_summary").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("invoice_delivery_events_org_id_unique").on(table.organizationId, table.id),
  uniqueIndex("invoice_delivery_events_provider_event_unique").on(table.providerEventId),
  index("invoice_delivery_events_attempt_idx").on(table.organizationId, table.attemptId, table.eventAt),
  foreignKey({
    columns: [table.organizationId, table.attemptId],
    foreignColumns: [invoiceDeliveryAttempts.organizationId, invoiceDeliveryAttempts.id],
    name: "invoice_delivery_events_tenant_attempt_fk",
  }).onDelete("restrict"),
]);

export const emailOperationEvents = pgTable("email_operation_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  category: text("category").notNull(),
  eventType: text("event_type").notNull(),
  aggregateId: uuid("aggregate_id"),
  outcome: text("outcome").notNull(),
  safeDetails: jsonb("safe_details").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("email_operation_events_org_id_unique").on(table.organizationId, table.id),
  index("email_operation_events_dashboard_idx").on(table.organizationId, table.category, table.occurredAt),
]);
