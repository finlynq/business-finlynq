import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./identity";

export const accountingProfile = pgEnum("accounting_profile", [
  "CAN_ASPE",
  "US_GAAP_NONPUBLIC",
]);

export const ledgerKind = pgEnum("ledger_kind", ["PRIMARY", "SECONDARY", "CONSOLIDATION"]);
export const manualPostingMode = pgEnum("manual_posting_mode", ["REVIEW_REQUIRED", "AUTO_POST"]);
export const periodState = pgEnum("period_state", [
  "OPEN",
  "ADJUSTMENT_ONLY",
  "HARD_CLOSED",
  "SEALED",
]);
export const accountClass = pgEnum("account_class", [
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "REVENUE",
  "EXPENSE",
]);
export const controlAccountKind = pgEnum("control_account_kind", ["NONE", "AR", "AP"]);
export const customSlotState = pgEnum("custom_slot_state", [
  "EMPTY",
  "CONFIGURED_UNBOUND",
  "ACTIVE_LOCKED",
  "INACTIVE_LOCKED",
]);

export const currencyDefinitions = pgTable("currency_definitions", {
  code: text("code").primaryKey(),
  minorUnits: integer("minor_units").notNull(),
  active: boolean("active").notNull().default(true),
});

export const organizationCurrencies = pgTable(
  "organization_currencies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencyDefinitions.code, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("organization_currencies_org_code_unique").on(
      table.organizationId,
      table.currencyCode,
    ),
    uniqueIndex("organization_currencies_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const currencyExchangeRates = pgTable(
  "currency_exchange_rates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    sourceCurrency: text("source_currency")
      .notNull()
      .references(() => currencyDefinitions.code, { onDelete: "restrict" }),
    targetCurrency: text("target_currency")
      .notNull()
      .references(() => currencyDefinitions.code, { onDelete: "restrict" }),
    rate: numeric("rate", { precision: 38, scale: 18 }).notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    source: text("source").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("currency_exchange_rates_org_identity_unique").on(
      table.organizationId,
      table.sourceCurrency,
      table.targetCurrency,
      table.effectiveAt,
      table.source,
    ),
    uniqueIndex("currency_exchange_rates_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const organizationFxProviderPolicyVersions = pgTable(
  "organization_fx_provider_policy_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    providerMode: text("provider_mode").notNull(),
    maxLookbackDays: integer("max_lookback_days").notNull(),
    licensedAndAuthorizedUseAcknowledged: boolean("licensed_and_authorized_use_acknowledged")
      .notNull()
      .default(false),
    reason: text("reason").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("organization_fx_provider_policy_versions_org_version_unique").on(
      table.organizationId,
      table.version,
    ),
    uniqueIndex("organization_fx_provider_policy_versions_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    check(
      "organization_fx_provider_policy_versions_version_check",
      sql`${table.version} > 0`,
    ),
    check(
      "organization_fx_provider_policy_versions_provider_check",
      sql`${table.providerMode} IN ('STORED_ONLY', 'BANK_OF_CANADA', 'EUROPEAN_CENTRAL_BANK', 'YAHOO_FINANCE_EXPERIMENTAL')`,
    ),
    check(
      "organization_fx_provider_policy_versions_lookback_check",
      sql`${table.maxLookbackDays} BETWEEN 1 AND 7`,
    ),
    check(
      "organization_fx_provider_policy_versions_acknowledgement_check",
      sql`(${table.providerMode} = 'YAHOO_FINANCE_EXPERIMENTAL' AND ${table.licensedAndAuthorizedUseAcknowledged})
        OR (${table.providerMode} <> 'YAHOO_FINANCE_EXPERIMENTAL' AND NOT ${table.licensedAndAuthorizedUseAcknowledged})`,
    ),
    check(
      "organization_fx_provider_policy_versions_reason_check",
      sql`char_length(btrim(${table.reason})) BETWEEN 8 AND 500`,
    ),
  ],
);

export const legalEntities = pgTable(
  "legal_entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    displayName: text("display_name").notNull(),
    countryCode: text("country_code").notNull(),
    regionCode: text("region_code").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("legal_entities_org_code_unique").on(table.organizationId, table.code),
    uniqueIndex("legal_entities_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const ledgers = pgTable(
  "ledgers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    legalEntityId: uuid("legal_entity_id")
      .notNull()
      .references(() => legalEntities.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    displayName: text("display_name").notNull(),
    kind: ledgerKind("kind").notNull().default("PRIMARY"),
    accountingProfile: accountingProfile("accounting_profile").notNull(),
    functionalCurrency: text("functional_currency").notNull(),
    active: boolean("active").notNull().default(true),
    firstPostedAt: timestamp("first_posted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ledgers_org_code_unique").on(table.organizationId, table.code),
    uniqueIndex("ledgers_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),
    fiscalYear: integer("fiscal_year").notNull(),
    periodNumber: integer("period_number").notNull(),
    label: text("label").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    state: periodState("state").notNull().default("OPEN"),
    version: integer("version").notNull().default(1),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("fiscal_periods_ledger_number_unique").on(
      table.ledgerId,
      table.fiscalYear,
      table.periodNumber,
    ),
    uniqueIndex("fiscal_periods_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const periodEvents = pgTable(
  "period_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),
    periodId: uuid("period_id")
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: "restrict" }),
    fromState: periodState("from_state").notNull(),
    toState: periodState("to_state").notNull(),
    reason: text("reason").notNull(),
    actorId: uuid("actor_id").notNull(),
    requestId: text("request_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("period_events_org_request_unique").on(table.organizationId, table.requestId),
    uniqueIndex("period_events_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const ledgerNumberSequences = pgTable(
  "ledger_number_sequences",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    nextValue: bigint("next_value", { mode: "number" }).notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("ledger_number_sequences_ledger_key_unique").on(table.ledgerId, table.key)],
);

export const ledgerPostingPolicies = pgTable(
  "ledger_posting_policies",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),
    manualMode: manualPostingMode("manual_mode").notNull().default("REVIEW_REQUIRED"),
    version: integer("version").notNull().default(1),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ledger_posting_policies_ledger_unique").on(table.ledgerId),
    uniqueIndex("ledger_posting_policies_org_ledger_unique").on(
      table.organizationId,
      table.ledgerId,
    ),
  ],
);

export const glAccounts = pgTable(
  "gl_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    displayName: text("display_name").notNull(),
    class: accountClass("class").notNull(),
    controlKind: controlAccountKind("control_kind").notNull().default("NONE"),
    postable: boolean("postable").notNull().default(true),
    active: boolean("active").notNull().default(true),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
  },
  (table) => [
    uniqueIndex("gl_accounts_ledger_code_unique").on(table.ledgerId, table.code),
    uniqueIndex("gl_accounts_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const segmentDefinitions = pgTable(
  "segment_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    ordinal: integer("ordinal").notNull(),
    displayName: text("display_name").notNull(),
    state: customSlotState("state").notNull(),
    required: boolean("required").notNull().default(false),
    visible: boolean("visible").notNull().default(true),
    protectedUseAt: timestamp("protected_use_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("segment_definitions_org_key_unique").on(table.organizationId, table.key),
    uniqueIndex("segment_definitions_org_ordinal_unique").on(table.organizationId, table.ordinal),
  ],
);

export const segmentValues = pgTable(
  "segment_values",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => segmentDefinitions.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    displayName: text("display_name").notNull(),
    active: boolean("active").notNull().default(true),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
  },
  (table) => [
    uniqueIndex("segment_values_definition_code_unique").on(table.definitionId, table.code),
    uniqueIndex("segment_values_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const accountingHierarchies = pgTable(
  "accounting_hierarchies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id").references(() => ledgers.id, { onDelete: "restrict" }),
    dimensionKey: text("dimension_key").notNull(),
    code: text("code").notNull(),
    displayName: text("display_name").notNull(),
    version: integer("version").notNull(),
    revision: integer("revision").notNull().default(1),
    status: text("status").notNull().default("DRAFT"),
    basedOnHierarchyId: uuid("based_on_hierarchy_id"),
    effectiveFrom: date("effective_from"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedBy: uuid("published_by"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("accounting_hierarchies_org_id_unique").on(table.organizationId, table.id),
    uniqueIndex("accounting_hierarchies_org_ledger_id_unique").on(
      table.organizationId,
      table.ledgerId,
      table.id,
    ),
    index("accounting_hierarchies_published_lookup").on(
      table.organizationId,
      table.ledgerId,
      table.dimensionKey,
      table.code,
      table.effectiveFrom,
    ),
    foreignKey({
      columns: [table.organizationId, table.basedOnHierarchyId],
      foreignColumns: [table.organizationId, table.id],
      name: "accounting_hierarchies_based_on_fk",
    }).onDelete("restrict"),
  ],
);

export const accountingHierarchyNodes = pgTable(
  "accounting_hierarchy_nodes",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    hierarchyId: uuid("hierarchy_id").notNull(),
    parentId: uuid("parent_id"),
    code: text("code").notNull(),
    displayName: text("display_name").notNull(),
    sortOrder: integer("sort_order").notNull(),
    statementClass: text("statement_class"),
    memberType: text("member_type"),
    glAccountId: uuid("gl_account_id"),
    segmentValueId: uuid("segment_value_id"),
    legalEntityId: uuid("legal_entity_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("accounting_hierarchy_nodes_org_hierarchy_id_unique").on(
      table.organizationId,
      table.hierarchyId,
      table.id,
    ),
    uniqueIndex("accounting_hierarchy_nodes_code_unique").on(table.hierarchyId, table.code),
    uniqueIndex("accounting_hierarchy_nodes_account_member_unique").on(
      table.hierarchyId,
      table.glAccountId,
    ),
    uniqueIndex("accounting_hierarchy_nodes_segment_member_unique").on(
      table.hierarchyId,
      table.segmentValueId,
    ),
    uniqueIndex("accounting_hierarchy_nodes_entity_member_unique").on(
      table.hierarchyId,
      table.legalEntityId,
    ),
    index("accounting_hierarchy_nodes_tree_order").on(
      table.hierarchyId,
      table.parentId,
      table.sortOrder,
      table.code,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.hierarchyId],
      foreignColumns: [accountingHierarchies.organizationId, accountingHierarchies.id],
      name: "accounting_hierarchy_nodes_hierarchy_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.hierarchyId, table.parentId],
      foreignColumns: [table.organizationId, table.hierarchyId, table.id],
      name: "accounting_hierarchy_nodes_parent_fk",
    }).onDelete("no action"),
    foreignKey({
      columns: [table.organizationId, table.glAccountId],
      foreignColumns: [glAccounts.organizationId, glAccounts.id],
      name: "accounting_hierarchy_nodes_account_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.segmentValueId],
      foreignColumns: [segmentValues.organizationId, segmentValues.id],
      name: "accounting_hierarchy_nodes_segment_value_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.legalEntityId],
      foreignColumns: [legalEntities.organizationId, legalEntities.id],
      name: "accounting_hierarchy_nodes_entity_fk",
    }).onDelete("restrict"),
  ],
);

export const accountCombinations = pgTable(
  "account_combinations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => legalEntities.id, { onDelete: "restrict" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => glAccounts.id, { onDelete: "restrict" }),
    subaccountId: uuid("subaccount_id").references(() => segmentValues.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").references(() => segmentValues.id, { onDelete: "restrict" }),
    intercompanyEntityId: uuid("intercompany_entity_id").references(() => legalEntities.id, {
      onDelete: "restrict",
    }),
    custom1Id: uuid("custom_1_id").references(() => segmentValues.id, { onDelete: "restrict" }),
    custom2Id: uuid("custom_2_id").references(() => segmentValues.id, { onDelete: "restrict" }),
    custom3Id: uuid("custom_3_id").references(() => segmentValues.id, { onDelete: "restrict" }),
    custom4Id: uuid("custom_4_id").references(() => segmentValues.id, { onDelete: "restrict" }),
    custom5Id: uuid("custom_5_id").references(() => segmentValues.id, { onDelete: "restrict" }),
    custom6Id: uuid("custom_6_id").references(() => segmentValues.id, { onDelete: "restrict" }),
    custom7Id: uuid("custom_7_id").references(() => segmentValues.id, { onDelete: "restrict" }),
    custom8Id: uuid("custom_8_id").references(() => segmentValues.id, { onDelete: "restrict" }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    schemaVersion: numeric("schema_version", { precision: 10, scale: 0 }).notNull().default("1"),
  },
  (table) => [uniqueIndex("account_combinations_org_id_unique").on(table.organizationId, table.id)],
);
