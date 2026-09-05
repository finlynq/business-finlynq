import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationMemberships, organizations, roles, users } from "./identity";
import {
  accountingProfile as accountingProfileEnum,
  currencyDefinitions,
  manualPostingMode as manualPostingModeEnum,
} from "./ledger";

export const demoSandboxPool = pgTable("demo_sandbox_pool", {
  singleton: boolean("singleton").primaryKey().default(true),
  cycle: bigint("cycle", { mode: "number" }).notNull().default(1),
  resetAfter: timestamp("reset_after", { withTimezone: true }).notNull(),
  initializedAt: timestamp("initialized_at", { withTimezone: true }).notNull().defaultNow(),
  lastCompletedResetAt: timestamp("last_completed_reset_at", { withTimezone: true }),
});

export const sharedDemoResetState = pgTable("shared_demo_reset_state", {
  singleton: boolean("singleton").primaryKey().default(true),
  status: text("status").notNull().default("RESETTING"),
  baselineVersion: integer("baseline_version").notNull().default(0),
  resetAfter: timestamp("reset_after", { withTimezone: true }).notNull(),
  initializedAt: timestamp("initialized_at", { withTimezone: true }).notNull().defaultNow(),
  resetStartedAt: timestamp("reset_started_at", { withTimezone: true }),
  lastCompletedResetAt: timestamp("last_completed_reset_at", { withTimezone: true }),
  lastError: text("last_error"),
});

export const demoSandboxResetTables = pgTable("demo_sandbox_reset_tables", {
  tableName: text("table_name").primaryKey(),
  purgeOrder: integer("purge_order").notNull().unique("demo_sandbox_reset_tables_purge_order_key"),
});

export const demoSandboxSlots = pgTable(
  "demo_sandbox_slots",
  {
    slot: integer("slot").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .unique("demo_sandbox_slots_organization_id_key")
      .references(() => organizations.id, { onDelete: "restrict" }),
    state: text("state").notNull().default("DIRTY"),
    generation: integer("generation").notNull().default(1),
    baselineVersion: integer("baseline_version").notNull().default(1),
    lastClaimedAt: timestamp("last_claimed_at", { withTimezone: true }),
    lastResetAt: timestamp("last_reset_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("demo_sandbox_slots_slot_org_unique").on(table.slot, table.organizationId),
  ],
);

export const demoDailyClaims = pgTable(
  "demo_daily_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull().unique("demo_daily_claims_token_hash_key"),
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

export const authTrustedBrowsers = pgTable(
  "auth_trusted_browsers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id").notNull().references(() => organizationMemberships.id, { onDelete: "restrict" }),
    userAgentHash: text("user_agent_hash").notNull(),
    browserLabel: text("browser_label").notNull(),
    securityEpoch: integer("security_epoch").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("auth_trusted_browsers_token_hash_unique").on(table.tokenHash),
    index("auth_trusted_browsers_user_active_idx").on(
      table.userId,
      table.organizationId,
      table.revokedAt,
      table.expiresAt,
    ),
    foreignKey({
      columns: [table.organizationId, table.membershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
      name: "auth_trusted_browsers_membership_fk",
    }).onDelete("restrict"),
    check("auth_trusted_browsers_token_hash_check", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("auth_trusted_browsers_user_agent_hash_check", sql`${table.userAgentHash} ~ '^[0-9a-f]{64}$'`),
    check("auth_trusted_browsers_label_check", sql`length(${table.browserLabel}) BETWEEN 1 AND 160 AND ${table.browserLabel} !~ '[[:cntrl:]]'`),
    check("auth_trusted_browsers_security_epoch_check", sql`${table.securityEpoch} > 0`),
    check("auth_trusted_browsers_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    check("auth_trusted_browsers_version_check", sql`${table.version} > 0`),
    check("auth_trusted_browsers_revocation_check", sql`(${table.revokedAt} IS NULL AND ${table.revokedReason} IS NULL) OR (${table.revokedAt} IS NOT NULL AND ${table.revokedReason} IS NOT NULL)`),
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
    tokenId: uuid("token_id")
      .notNull()
      .unique("auth_organization_signups_token_id_key")
      .references(() => authOneTimeTokens.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .unique("auth_organization_signups_user_id_key")
      .references(() => users.id, { onDelete: "restrict" }),
    identityEncryptionUserId: uuid("identity_encryption_user_id").notNull(),
    requestedEmailCiphertext: text("requested_email_ciphertext").notNull(),
    requestedDisplayNameCiphertext: text("requested_display_name_ciphertext").notNull(),
    // The deterministic tenant identifier is reserved before the tenant is
    // provisioned, so this intentionally is not an organizations foreign key.
    organizationId: uuid("organization_id").notNull().unique("auth_organization_signups_organization_id_key"),
    organizationSlug: text("organization_slug").notNull().unique("auth_organization_signups_organization_slug_key"),
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
  (table) => [
    index("auth_organization_signups_status_expiry_idx").on(table.status, table.expiresAt),
    foreignKey({
      columns: [table.functionalCurrency],
      foreignColumns: [currencyDefinitions.code],
      name: "auth_organization_signups_functional_currency_fk",
    }).onDelete("restrict"),
  ],
);

export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id").notNull(),
    roleId: uuid("role_id").notNull(),
    tokenId: uuid("token_id").references(() => authOneTimeTokens.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("PENDING"),
    invitedByUserId: uuid("invited_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.membershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
      name: "organization_invitations_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.roleId],
      foreignColumns: [roles.organizationId, roles.id],
      name: "organization_invitations_role_fk",
    }).onDelete("restrict"),
    unique("organization_invitations_membership_unique").on(table.organizationId, table.membershipId),
    uniqueIndex("organization_invitations_one_pending_user_unique")
      .on(table.organizationId, table.userId)
      .where(sql`${table.status} = 'PENDING'`),
    index("organization_invitations_org_status_idx").on(
      table.organizationId,
      table.status,
      table.expiresAt,
    ),
  ],
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
    tokenId: uuid("token_id")
      .notNull()
      .unique("auth_recovery_requests_token_id_key")
      .references(() => authOneTimeTokens.id, { onDelete: "restrict" }),
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
  (table) => [
    index("auth_email_outbox_user_created_idx").on(table.userId, table.createdAt),
    index("auth_email_outbox_sent_at_idx")
      .on(table.sentAt)
      .where(sql`${table.status} = 'SENT'`),
    index("auth_email_outbox_delivery_dead_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'DEAD' AND upper(coalesce(${table.lastErrorCode}, '')) NOT IN ('CANCELLED', 'INVALIDATED_BY_MFA_ENROLLMENT', 'SUPERSEDED', 'SUPERSEDED_BY_INVITATION', 'SUPERSEDED_BY_SIGNUP')`),
  ],
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
