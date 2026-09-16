import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./identity";
import { currencyDefinitions, glAccounts, legalEntities, ledgers } from "./ledger";

export const taxPackVersions = pgTable(
  "tax_pack_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    packKey: text("pack_key").notNull(),
    version: text("version").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    sourceUri: text("source_uri").notNull(),
    sourceDigest: text("source_digest").notNull(),
    approvedBy: uuid("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex("tax_pack_versions_key_version_unique").on(table.packKey, table.version)],
);

export const entityTaxRegistrations = pgTable(
  "entity_tax_registrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    legalEntityId: uuid("legal_entity_id")
      .notNull()
      .references(() => legalEntities.id, { onDelete: "restrict" }),
    regimeKey: text("regime_key").notNull(),
    destinationCountry: text("destination_country"),
    destinationRegion: text("destination_region"),
    destinationCity: text("destination_city"),
    locationCode: text("location_code"),
    configurationEvidence: text("configuration_evidence"),
    registrationCiphertext: text("registration_ciphertext").notNull(),
    keyVersion: text("key_version").notNull(),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
  },
  (table) => [
    uniqueIndex("entity_tax_registrations_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const taxDeterminationSnapshots = pgTable(
  "tax_determination_snapshots",
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
    taxPackVersionId: uuid("tax_pack_version_id")
      .notNull()
      .references(() => taxPackVersions.id, { onDelete: "restrict" }),
    sourceDocumentId: uuid("source_document_id").notNull(),
    status: text("status").notNull(),
    ruleKey: text("rule_key").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    currency: text("currency").notNull(),
    taxableBasis: numeric("taxable_basis", { precision: 38, scale: 9 }).notNull(),
    totalTax: numeric("total_tax", { precision: 38, scale: 9 }).notNull(),
    factSnapshot: jsonb("fact_snapshot").notNull(),
    evidenceSnapshot: jsonb("evidence_snapshot").notNull(),
    componentSnapshot: jsonb("component_snapshot").notNull(),
    roundingSnapshot: jsonb("rounding_snapshot").notNull(),
    glMappingSnapshot: jsonb("gl_mapping_snapshot").notNull(),
    decisionHash: text("decision_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tax_determination_snapshots_org_id_unique").on(table.organizationId, table.id),
  ],
);

/**
 * Shared, immutable filing definitions. A version is deliberately global so
 * the same reviewed form and rule set can be used by every organization.
 * Client-specific choices live only in the tenant-owned mapping tables below.
 */
export const taxFilingTemplates = pgTable(
  "tax_filing_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateKey: text("template_key").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    authority: text("authority").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    formCode: text("form_code").notNull(),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencyDefinitions.code, { onDelete: "restrict" }),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    definition: jsonb("definition").notNull(),
    sourceUri: text("source_uri").notNull(),
    sourceDigest: text("source_digest").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("tax_filing_templates_key_version_unique").on(table.templateKey, table.version),
    check("tax_filing_templates_version_check", sql`${table.version} > 0`),
    check(
      "tax_filing_templates_effective_period_check",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    check(
      "tax_filing_templates_definition_check",
      sql`jsonb_typeof(${table.definition}) = 'object' AND (${table.definition} ->> 'schemaVersion')::integer = 1`,
    ),
    check(
      "tax_filing_templates_source_digest_check",
      sql`${table.sourceDigest} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/**
 * Mapping sets are append-only versions. A filing points at the exact mapping
 * version used to calculate it, so later account changes cannot rewrite tax
 * workpaper history.
 */
export const taxAccountMappingSets = pgTable(
  "tax_account_mapping_sets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    legalEntityId: uuid("legal_entity_id").notNull(),
    ledgerId: uuid("ledger_id").notNull(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => taxFilingTemplates.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    commandHash: text("command_hash").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tax_account_mapping_sets_org_id_unique").on(table.organizationId, table.id),
    uniqueIndex("tax_account_mapping_sets_scope_version_unique").on(
      table.organizationId,
      table.ledgerId,
      table.templateId,
      table.version,
    ),
    uniqueIndex("tax_account_mapping_sets_org_idempotency_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("tax_account_mapping_sets_active_lookup").on(
      table.organizationId,
      table.ledgerId,
      table.templateId,
      table.version,
    ),
    foreignKey({
      columns: [table.organizationId, table.legalEntityId],
      foreignColumns: [legalEntities.organizationId, legalEntities.id],
      name: "tax_account_mapping_sets_org_entity_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.ledgerId],
      foreignColumns: [ledgers.organizationId, ledgers.id],
      name: "tax_account_mapping_sets_org_ledger_fk",
    }).onDelete("restrict"),
    check("tax_account_mapping_sets_version_check", sql`${table.version} > 0`),
    check(
      "tax_account_mapping_sets_reason_check",
      sql`char_length(btrim(${table.reason})) BETWEEN 8 AND 500`,
    ),
    check(
      "tax_account_mapping_sets_hash_check",
      sql`${table.commandHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const taxAccountMappingLines = pgTable(
  "tax_account_mapping_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    mappingSetId: uuid("mapping_set_id").notNull(),
    fieldKey: text("field_key").notNull(),
    glAccountId: uuid("gl_account_id").notNull(),
    balanceBasis: text("balance_basis").notNull(),
    multiplier: numeric("multiplier", { precision: 12, scale: 6 }).notNull().default("1"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tax_account_mapping_lines_org_id_unique").on(table.organizationId, table.id),
    uniqueIndex("tax_account_mapping_lines_identity_unique").on(
      table.mappingSetId,
      table.fieldKey,
      table.glAccountId,
    ),
    index("tax_account_mapping_lines_set_field_idx").on(table.mappingSetId, table.fieldKey),
    foreignKey({
      columns: [table.organizationId, table.mappingSetId],
      foreignColumns: [taxAccountMappingSets.organizationId, taxAccountMappingSets.id],
      name: "tax_account_mapping_lines_org_set_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.glAccountId],
      foreignColumns: [glAccounts.organizationId, glAccounts.id],
      name: "tax_account_mapping_lines_org_account_fk",
    }).onDelete("restrict"),
    check(
      "tax_account_mapping_lines_basis_check",
      sql`${table.balanceBasis} IN ('DEBITS', 'CREDITS', 'NET_DEBIT', 'NET_CREDIT', 'ABSOLUTE_NET')`,
    ),
    check(
      "tax_account_mapping_lines_multiplier_check",
      sql`${table.multiplier} BETWEEN -1000 AND 1000 AND ${table.multiplier} <> 0`,
    ),
  ],
);

/** Append-only prepared returns and imported historical filing snapshots. */
export const taxFilings = pgTable(
  "tax_filings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    legalEntityId: uuid("legal_entity_id").notNull(),
    ledgerId: uuid("ledger_id").notNull(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => taxFilingTemplates.id, { onDelete: "restrict" }),
    mappingSetId: uuid("mapping_set_id").notNull(),
    filingType: text("filing_type").notNull(),
    status: text("status").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    externalReference: text("external_reference"),
    sourceFileName: text("source_file_name"),
    reportedValues: jsonb("reported_values").notNull(),
    calculatedValues: jsonb("calculated_values").notNull(),
    reconciliationSnapshot: jsonb("reconciliation_snapshot").notNull(),
    validationSnapshot: jsonb("validation_snapshot").notNull(),
    templateSnapshot: jsonb("template_snapshot").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    commandHash: text("command_hash").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tax_filings_org_id_unique").on(table.organizationId, table.id),
    uniqueIndex("tax_filings_org_idempotency_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("tax_filings_scope_period_idx").on(
      table.organizationId,
      table.ledgerId,
      table.templateId,
      table.periodEnd,
    ),
    foreignKey({
      columns: [table.organizationId, table.legalEntityId],
      foreignColumns: [legalEntities.organizationId, legalEntities.id],
      name: "tax_filings_org_entity_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.ledgerId],
      foreignColumns: [ledgers.organizationId, ledgers.id],
      name: "tax_filings_org_ledger_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.mappingSetId],
      foreignColumns: [taxAccountMappingSets.organizationId, taxAccountMappingSets.id],
      name: "tax_filings_org_mapping_set_fk",
    }).onDelete("restrict"),
    check(
      "tax_filings_type_check",
      sql`${table.filingType} IN ('PREPARED', 'HISTORICAL_IMPORT')`,
    ),
    check(
      "tax_filings_status_check",
      sql`${table.status} IN ('READY', 'MATCHED', 'REVIEW_REQUIRED')`,
    ),
    check("tax_filings_period_check", sql`${table.periodStart} <= ${table.periodEnd}`),
    check(
      "tax_filings_payload_check",
      sql`jsonb_typeof(${table.reportedValues}) = 'object'
        AND jsonb_typeof(${table.calculatedValues}) = 'object'
        AND jsonb_typeof(${table.reconciliationSnapshot}) = 'array'
        AND jsonb_typeof(${table.validationSnapshot}) = 'array'
        AND jsonb_typeof(${table.templateSnapshot}) = 'object'`,
    ),
    check(
      "tax_filings_import_evidence_check",
      sql`${table.filingType} <> 'HISTORICAL_IMPORT'
        OR (${table.externalReference} IS NOT NULL
          AND char_length(btrim(${table.externalReference})) BETWEEN 1 AND 200
          AND jsonb_object_length(${table.reportedValues}) > 0)`,
    ),
    check("tax_filings_hash_check", sql`${table.commandHash} ~ '^[a-f0-9]{64}$'`),
  ],
);
