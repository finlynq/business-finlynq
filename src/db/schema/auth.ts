import {
  bigint,
  boolean,
  foreignKey,
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
import { sql } from "drizzle-orm";
import { organizationMemberships, organizations, users } from "./identity";
import {
  accountingProfile as accountingProfileEnum,
  manualPostingMode as manualPostingModeEnum,
} from "./ledger";

export const demoSandboxPool = pgTable("demo_sandbox_pool", {
  singleton: boolean("singleton").primaryKey().default(true),
  cycle: bigint("cycle", { mode: "number" }).notNull().default(1),
  resetAfter: timestamp("reset_after", { withTimezone: true }).notNull(),
  initializedAt: timestamp("initialized_at", { withTimezone: true }).notNull().defaultNow(),
  lastCompletedResetAt: timestamp("last_completed_reset_at", { withTimezone: true }),
});

export const demoSandboxResetTables = pgTable("demo_sandbox_reset_tables", {
  tableName: text("table_name").primaryKey(),
  purgeOrder: integer("purge_order").notNull().unique(),
});

export const demoSandboxSlots = pgTable(
  "demo_sandbox_slots",
  {
    slot: integer("slot").primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    state: text("state").notNull().default("DIRTY"),
    generation: integer("generation").notNull().default(1),
    baselineVersion: integer("baseline_version").notNull().default(1),
    lastClaimedAt: timestamp("last_claimed_at", { withTimezone: true }),
    lastResetAt: timestamp("last_reset_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("demo_sandbox_slots_organization_unique").on(table.organizationId),
    uniqueIndex("demo_sandbox_slots_slot_org_unique").on(table.slot, table.organizationId),
  ],
);

export const demoDailyClaims = pgTable(
  "demo_daily_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    slot: integer("slot").notNull(),
    organizationId: uuid("organization_id").notNull(),
    generation: integer("generation").notNull(),
    poolCycle: bigint("pool_cycle", { mode: "number" }).notNull(),
    ipHash: text("ip_hash").notNull(),
    userAgentHash: text("user_agent_hash"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("demo_daily_claims_token_hash_unique").on(table.tokenHash),
    uniqueIndex("demo_daily_claims_one_active_per_org_unique")
      .on(table.organizationId)
      .where(sql`${table.invalidatedAt} IS NULL`),
    index("demo_daily_claims_ip_cycle_idx").on(table.ipHash, table.poolCycle, table.invalidatedAt),
    foreignKey({
      columns: [table.slot, table.organizationId],
      foreignColumns: [demoSandboxSlots.slot, demoSandboxSlots.organizationId],
      name: "demo_daily_claims_slot_org_fk",
    }).onDelete("restrict"),
  ],
);

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
    mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
    stepUpExpiresAt: timestamp("step_up_expires_at", { withTimezone: true }),
    demoGeneration: integer("demo_generation"),
    demoClaimId: uuid("demo_claim_id").references(() => demoDailyClaims.id, { onDelete: "restrict" }),
  },
  (table) => [
    uniqueIndex("auth_sessions_token_hash_unique").on(table.tokenHash),
    index("auth_sessions_user_active_idx").on(table.userId, table.revokedAt, table.expiresAt),
    index("auth_sessions_demo_claim_idx").on(table.demoClaimId, table.revokedAt, table.expiresAt),
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
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    recoveryPolicy: text("recovery_policy"),
    recoveryAuthorizedAt: timestamp("recovery_authorized_at", { withTimezone: true }),
    recoveryAuthorizedBy: uuid("recovery_authorized_by").references(() => users.id, { onDelete: "restrict" }),
  },
  (table) => [
    uniqueIndex("auth_one_time_tokens_hash_unique").on(table.tokenHash),
    index("auth_one_time_tokens_user_purpose_idx").on(table.userId, table.purpose, table.expiresAt),
  ],
);

export const authOrganizationSignups = pgTable(
  "auth_organization_signups",
  {
    id: uuid("id").primaryKey(),
    tokenId: uuid("token_id").notNull().unique().references(() => authOneTimeTokens.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().unique().references(() => users.id, { onDelete: "restrict" }),
    // The deterministic tenant identifier is reserved before the tenant is
    // provisioned, so this intentionally is not an organizations foreign key.
    organizationId: uuid("organization_id").notNull().unique(),
    organizationSlug: text("organization_slug").notNull().unique(),
    organizationName: text("organization_name").notNull(),
    entityCode: text("entity_code").notNull(),
    entityName: text("entity_name").notNull(),
    countryCode: text("country_code").notNull(),
    regionCode: text("region_code").notNull(),
    functionalCurrency: text("functional_currency").notNull(),
    accountingProfile: accountingProfileEnum("accounting_profile").notNull(),
    fiscalYear: integer("fiscal_year").notNull(),
    manualPostingMode: manualPostingModeEnum("manual_posting_mode").notNull(),
    keyProvider: text("key_provider").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    termsVersion: text("terms_version").notNull(),
    status: text("status").notNull().default("PENDING"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("auth_organization_signups_status_expiry_idx").on(table.status, table.expiresAt)],
);

export const authMfaFactors = pgTable(
  "auth_mfa_factors",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    recoveryTokenId: uuid("recovery_token_id").references(() => authOneTimeTokens.id, { onDelete: "restrict" }),
    factorType: text("factor_type").notNull(),
    label: text("label").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    status: text("status").notNull(),
    lastAcceptedCounter: bigint("last_accepted_counter", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("auth_mfa_factors_user_status_idx").on(table.userId, table.status)],
);

export const authRecoveryRequests = pgTable(
  "auth_recovery_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenId: uuid("token_id").notNull().references(() => authOneTimeTokens.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "restrict" }),
    policy: text("policy").notNull(),
    status: text("status").notNull().default("PENDING"),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("auth_recovery_requests_token_unique").on(table.tokenId),
    index("auth_recovery_requests_org_status_idx").on(table.organizationId, table.status, table.expiresAt),
  ],
);

export const authEmailOutbox = pgTable(
  "auth_email_outbox",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "restrict" }),
    templateType: text("template_type").notNull(),
    payloadCiphertext: text("payload_ciphertext"),
    templateData: jsonb("template_data").notNull().default({}),
    status: text("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: uuid("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    lastErrorCode: text("last_error_code"),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [index("auth_email_outbox_user_created_idx").on(table.userId, table.createdAt)],
);

export const authEmailWorkerStatus = pgTable(
  "auth_email_worker_status",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    workerId: uuid("worker_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
  },
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
