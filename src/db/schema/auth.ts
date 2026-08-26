import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizationMemberships, organizations, users } from "./identity";

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id").notNull().references(() => organizationMemberships.id, { onDelete: "restrict" }),
    authMethod: text("auth_method").notNull(),
    sessionMode: text("session_mode").notNull(),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    idleTimeoutSeconds: integer("idle_timeout_seconds").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("auth_sessions_token_hash_unique").on(table.tokenHash),
    index("auth_sessions_user_active_idx").on(table.userId, table.revokedAt, table.expiresAt),
  ],
);

export const authOneTimeTokens = pgTable(
  "auth_one_time_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    purpose: text("purpose").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "restrict" }),
    requestedIpHash: text("requested_ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("auth_one_time_tokens_hash_unique").on(table.tokenHash),
    index("auth_one_time_tokens_user_purpose_idx").on(table.userId, table.purpose, table.expiresAt),
  ],
);

export const authRateLimits = pgTable(
  "auth_rate_limits",
  {
    scope: text("scope").notNull(),
    keyHash: text("key_hash").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.keyHash] })],
);

export const authSecurityEvents = pgTable(
  "auth_security_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "restrict" }),
    sessionId: uuid("session_id").references(() => authSessions.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    outcome: text("outcome").notNull(),
    requestId: text("request_id").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("auth_security_events_created_idx").on(table.createdAt)],
);
