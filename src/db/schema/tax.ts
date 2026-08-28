import {
  date,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./identity";
import { legalEntities, ledgers } from "./ledger";

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
