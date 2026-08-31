import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./identity";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    delegatedIdentity: text("delegated_identity"),
    authMethod: text("auth_method").notNull(),
    sourceSurface: text("source_surface").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    requestId: text("request_id").notNull(),
    reason: text("reason"),
    safeMetadata: jsonb("safe_metadata").notNull(),
    previousEventHash: text("previous_event_hash"),
    eventHash: text("event_hash").notNull(),
    hashMaterialVersion: text("hash_material_version").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_org_previous_hash_idx").on(
      table.organizationId,
      table.previousEventHash,
    ),
    uniqueIndex("audit_events_org_request_action_entity_unique").on(
      table.organizationId,
      table.requestId,
      table.action,
      table.entityType,
      table.entityId,
    ),
    check(
      "audit_events_hash_material_version_check",
      sql`(
        (${table.action} = 'journal.posted' AND ${table.hashMaterialVersion} = 'journal-posted-v1')
        OR (${table.action} = 'period.transition' AND ${table.hashMaterialVersion} = 'period-transition-v1')
        OR (
          ${table.action} NOT IN ('journal.posted', 'period.transition')
          AND ${table.hashMaterialVersion} = 'tenant-business-v1'
        )
      )`,
    ),
  ],
);

export const auditOutboxPairContract = pgTable(
  "audit_outbox_pair_contract",
  {
    auditAction: text("audit_action").primaryKey(),
    outboxTopic: text("outbox_topic").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    contractVersion: text("contract_version").notNull(),
  },
  (table) => [
    unique("audit_outbox_pair_contract_topic_aggregate_unique").on(
      table.outboxTopic,
      table.aggregateType,
    ),
    check(
      "audit_outbox_pair_contract_version_check",
      sql`${table.contractVersion} = 'business-audit-outbox-v1'`,
    ),
    check(
      "audit_outbox_pair_contract_names_check",
      sql`length(${table.auditAction}) BETWEEN 1 AND 120
        AND length(${table.outboxTopic}) BETWEEN 1 AND 120
        AND length(${table.aggregateType}) BETWEEN 1 AND 120
        AND ${table.auditAction} !~ E'[\\r\\n]'
        AND ${table.outboxTopic} !~ E'[\\r\\n]'
        AND ${table.aggregateType} !~ E'[\\r\\n]'`,
    ),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    topic: text("topic").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    requestId: text("request_id").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("outbox_events_org_id_unique").on(table.organizationId, table.id),
    uniqueIndex("outbox_events_audit_pair_unique").on(
      table.organizationId,
      table.requestId,
      table.topic,
      table.aggregateType,
      table.aggregateId,
    ),
    index("outbox_events_org_request_idx").on(table.organizationId, table.requestId),
    index("outbox_events_unpublished_created_idx").on(table.publishedAt, table.createdAt),
    index("outbox_events_created_idx").on(table.createdAt),
    index("outbox_events_legacy_request_idx")
      .on(table.requestId)
      .where(sql`${table.requestId} LIKE 'legacy:%'`),
    check(
      "outbox_events_request_id_check",
      sql`length(${table.requestId}) BETWEEN 1 AND 200 AND ${table.requestId} !~ E'[\\r\\n]'`,
    ),
    foreignKey({
      columns: [table.topic, table.aggregateType],
      foreignColumns: [auditOutboxPairContract.outboxTopic, auditOutboxPairContract.aggregateType],
      name: "outbox_events_topic_aggregate_contract_fk",
    }).onDelete("restrict").onUpdate("restrict"),
  ],
);
