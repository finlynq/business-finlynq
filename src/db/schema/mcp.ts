import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authSessions } from "./auth";
import { organizationMemberships, organizations, users } from "./identity";

export const mcpOauthClients = pgTable(
  "mcp_oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientName: text("client_name").notNull(),
    redirectUris: text("redirect_uris").array().notNull(),
    grantTypes: text("grant_types").array().notNull().default(["authorization_code", "refresh_token"]),
    responseTypes: text("response_types").array().notNull().default(["code"]),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("mcp_oauth_clients_name_length", sql`length(${table.clientName}) BETWEEN 1 AND 120`),
    check("mcp_oauth_clients_redirects_present", sql`cardinality(${table.redirectUris}) BETWEEN 1 AND 20`),
    check("mcp_oauth_clients_public_only", sql`${table.tokenEndpointAuthMethod} = 'none'`),
  ],
);

export const mcpConnections = pgTable(
  "mcp_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id").notNull(),
    clientId: text("client_id").notNull().references(() => mcpOauthClients.clientId, { onDelete: "restrict" }),
    clientName: text("client_name").notNull(),
    scopes: text("scopes").array().notNull(),
    dailyMode: text("daily_mode").notNull().default("CONFIRM_WRITES"),
    setupMode: text("setup_mode").notNull().default("OFF"),
    toolOverrides: jsonb("tool_overrides").$type<Record<string, string>>().notNull().default({}),
    directWriteSessionId: uuid("direct_write_session_id").references(() => authSessions.id, { onDelete: "restrict" }),
    directWriteStepUpExpiresAt: timestamp("direct_write_step_up_expires_at", { withTimezone: true }),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.membershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
      name: "mcp_connections_membership_fk",
    }).onDelete("restrict"),
    uniqueIndex("mcp_connections_one_active_client_user_unique")
      .on(table.organizationId, table.userId, table.clientId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("mcp_connections_org_user_idx").on(table.organizationId, table.userId, table.revokedAt),
    check("mcp_connections_daily_mode_check", sql`${table.dailyMode} IN ('OFF','READ_ONLY','CONFIRM_WRITES','ALLOW_WRITES')`),
    check("mcp_connections_setup_mode_check", sql`${table.setupMode} IN ('OFF','READ_ONLY','CONFIRM_WRITES','ALLOW_WRITES')`),
  ],
);

export const mcpOauthCodes = pgTable(
  "mcp_oauth_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    connectionId: uuid("connection_id").notNull().references(() => mcpConnections.id, { onDelete: "restrict" }),
    clientId: text("client_id").notNull().references(() => mcpOauthClients.clientId, { onDelete: "restrict" }),
    codeHash: text("code_hash").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    resource: text("resource").notNull(),
    scopes: text("scopes").array().notNull(),
    codeChallenge: text("code_challenge").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("mcp_oauth_codes_hash_unique").on(table.codeHash),
    index("mcp_oauth_codes_org_expiry_idx").on(table.organizationId, table.expiresAt, table.consumedAt),
    check("mcp_oauth_codes_challenge_check", sql`${table.codeChallenge} ~ '^[A-Za-z0-9_-]{43}$'`),
  ],
);

export const mcpAccessTokens = pgTable(
  "mcp_access_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    connectionId: uuid("connection_id").notNull().references(() => mcpConnections.id, { onDelete: "restrict" }),
    clientId: text("client_id").notNull().references(() => mcpOauthClients.clientId, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    resource: text("resource").notNull(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("mcp_access_tokens_hash_unique").on(table.tokenHash),
    index("mcp_access_tokens_connection_idx").on(table.organizationId, table.connectionId, table.revokedAt, table.expiresAt),
  ],
);

export const mcpRefreshTokens = pgTable(
  "mcp_refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    familyId: uuid("family_id").notNull(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    connectionId: uuid("connection_id").notNull().references(() => mcpConnections.id, { onDelete: "restrict" }),
    clientId: text("client_id").notNull().references(() => mcpOauthClients.clientId, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    resource: text("resource").notNull(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("mcp_refresh_tokens_hash_unique").on(table.tokenHash),
    index("mcp_refresh_tokens_family_idx").on(table.organizationId, table.familyId, table.revokedAt),
  ],
);

export const mcpApprovals = pgTable(
  "mcp_approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    connectionId: uuid("connection_id").notNull().references(() => mcpConnections.id, { onDelete: "restrict" }),
    toolName: text("tool_name").notNull(),
    argumentsHash: text("arguments_hash").notNull(),
    argumentsSummary: jsonb("arguments_summary").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("PENDING"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    mfaSessionId: uuid("mfa_session_id").references(() => authSessions.id, { onDelete: "restrict" }),
    mfaStepUpExpiresAt: timestamp("mfa_step_up_expires_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    index("mcp_approvals_pending_idx").on(table.organizationId, table.userId, table.status, table.expiresAt),
    check("mcp_approvals_status_check", sql`${table.status} IN ('PENDING','APPROVED','REJECTED','CONSUMED','EXPIRED')`),
  ],
);

export const mcpToolExecutions = pgTable(
  "mcp_tool_executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    connectionId: uuid("connection_id").notNull().references(() => mcpConnections.id, { onDelete: "restrict" }),
    requestId: text("request_id").notNull(),
    toolName: text("tool_name").notNull(),
    toolGroup: text("tool_group").notNull(),
    writeAction: boolean("write_action").notNull(),
    argumentsHash: text("arguments_hash").notNull(),
    approvalId: uuid("approval_id").references(() => mcpApprovals.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    resultSummary: jsonb("result_summary").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("mcp_tool_executions_request_unique").on(table.organizationId, table.connectionId, table.requestId),
    index("mcp_tool_executions_org_started_idx").on(table.organizationId, table.startedAt),
    check("mcp_tool_executions_group_check", sql`${table.toolGroup} IN ('DAILY','SETUP','SHARED')`),
    check("mcp_tool_executions_status_check", sql`${table.status} IN ('STARTED','APPROVAL_REQUIRED','SUCCEEDED','FAILED')`),
  ],
);
