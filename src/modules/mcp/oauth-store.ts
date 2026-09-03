import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { queryDatabase, withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import type { SessionPrincipal } from "@/modules/identity/session";
import {
  McpOAuthError,
  hashMcpSecret,
  isScopeSubset,
  mintBoundToken,
  parseAccessMode,
  parseBoundToken,
  parseToolOverrides,
  verifyPkceS256,
  type McpAccessMode,
  type McpOAuthScope,
  type McpToolOverride,
} from "./protocol";

const ACCESS_TOKEN_SECONDS = 10 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_SECONDS = 5 * 60;

export type McpOAuthClient = Readonly<{
  clientId: string;
  clientName: string;
  redirectUris: readonly string[];
}>;

export type McpConnectionPrincipal = Readonly<{
  connectionId: string;
  organizationId: string;
  userId: string;
  membershipId: string;
  organizationName: string;
  roleLabel: string;
  clientId: string;
  clientName: string;
  scopes: readonly string[];
  resource: string;
  dailyMode: McpAccessMode;
  setupMode: McpAccessMode;
  toolOverrides: Readonly<Record<string, McpToolOverride>>;
  tokenExpiresAt: Date;
  organizationWritesEnabled: boolean;
}>;

type StoredClient = Readonly<{
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  active: boolean;
}>;

function oauthTenantContext(
  organizationId: string,
  userId: string,
  requestId: string,
  reason: string,
): TenantTransactionContext {
  return {
    organizationId,
    actorId: userId,
    requestId,
    authMethod: "oauth2.1+pkce",
    sourceSurface: "MCP",
    reason,
  };
}

function clientFromRow(row: StoredClient): McpOAuthClient {
  return { clientId: row.client_id, clientName: row.client_name, redirectUris: row.redirect_uris };
}

export async function registerOAuthClient(input: Readonly<{
  clientName: string;
  redirectUris: readonly string[];
}>): Promise<McpOAuthClient> {
  const clientId = `finlynq_${randomUUID()}`;
  const result = await queryDatabase<StoredClient>(
    `INSERT INTO mcp_oauth_clients (
       client_id, client_name, redirect_uris, grant_types,
       response_types, token_endpoint_auth_method
     ) VALUES ($1, $2, $3::text[], ARRAY['authorization_code','refresh_token'], ARRAY['code'], 'none')
     RETURNING client_id, client_name, redirect_uris, active`,
    [clientId, input.clientName, input.redirectUris],
  );
  const row = result.rows[0];
  if (!row) throw new McpOAuthError("server_error", "OAuth client registration failed", 500);
  return clientFromRow(row);
}

export async function loadOAuthClient(clientId: string): Promise<McpOAuthClient | null> {
  if (!/^finlynq_[0-9a-f-]{36}$/i.test(clientId)) return null;
  const result = await queryDatabase<StoredClient>(
    `SELECT client_id, client_name, redirect_uris, active
     FROM mcp_oauth_clients
     WHERE client_id = $1 AND active`,
    [clientId],
  );
  return result.rows[0] ? clientFromRow(result.rows[0]) : null;
}

export async function createAuthorizationGrant(input: Readonly<{
  principal: SessionPrincipal;
  client: McpOAuthClient;
  redirectUri: string;
  resource: string;
  scopes: readonly McpOAuthScope[];
  codeChallenge: string;
}>): Promise<string> {
  if (input.principal.sessionMode !== "real") {
    throw new McpOAuthError("access_denied", "Remote MCP connections are available only to signed-in business users", 403);
  }
  const rawCode = mintBoundToken("ac", input.principal.organizationId, input.principal.userId);
  const context = oauthTenantContext(
    input.principal.organizationId,
    input.principal.userId,
    `mcp-consent:${randomUUID()}`,
    `Authorize MCP client ${input.client.clientId}`,
  );
  await withTenantTransaction(context, async (client) => {
    const membership = await client.query(
      `SELECT 1
       FROM organization_memberships membership
       JOIN organizations organization ON organization.id = membership.organization_id
       WHERE membership.organization_id = $1 AND membership.id = $2
         AND membership.user_id = $3 AND membership.active
         AND organization.active AND NOT organization.is_demo
         AND app.mcp_user_is_active(membership.user_id)`,
      [input.principal.organizationId, input.principal.membershipId, input.principal.userId],
    );
    if (!membership.rows[0]) throw new McpOAuthError("access_denied", "The selected organization membership is no longer active", 403);

    const connection = await client.query<{ id: string }>(
      `INSERT INTO mcp_connections (
         organization_id, user_id, membership_id, client_id, client_name, scopes
       ) VALUES ($1, $2, $3, $4, $5, $6::text[])
       ON CONFLICT (organization_id, user_id, client_id) WHERE revoked_at IS NULL
       DO UPDATE SET membership_id = EXCLUDED.membership_id,
         client_name = EXCLUDED.client_name, scopes = EXCLUDED.scopes,
         authorized_at = now(), version = mcp_connections.version + 1
       RETURNING id`,
      [
        input.principal.organizationId,
        input.principal.userId,
        input.principal.membershipId,
        input.client.clientId,
        input.client.clientName,
        input.scopes,
      ],
    );
    const connectionId = connection.rows[0]?.id;
    if (!connectionId) throw new McpOAuthError("server_error", "MCP connection could not be created", 500);

    await client.query(
      `INSERT INTO mcp_oauth_codes (
         organization_id, user_id, connection_id, client_id, code_hash,
         redirect_uri, resource, scopes, code_challenge, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10)`,
      [
        input.principal.organizationId,
        input.principal.userId,
        connectionId,
        input.client.clientId,
        hashMcpSecret(rawCode),
        input.redirectUri,
        input.resource,
        input.scopes,
        input.codeChallenge,
        new Date(Date.now() + AUTHORIZATION_CODE_SECONDS * 1000),
      ],
    );
  });
  return rawCode;
}

type GrantRow = Readonly<{
  connection_id: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  scopes: string[];
  code_challenge: string;
}>;

export type OAuthTokenSet = Readonly<{
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope: string;
}>;

async function mintTokenSet(
  client: PoolClient,
  input: Readonly<{
    organizationId: string;
    userId: string;
    connectionId: string;
    clientId: string;
    resource: string;
    scopes: readonly string[];
    familyId?: string;
    includeRefresh: boolean;
  }>,
): Promise<OAuthTokenSet> {
  const accessToken = mintBoundToken("at", input.organizationId, input.userId);
  await client.query(
    `INSERT INTO mcp_access_tokens (
       organization_id, user_id, connection_id, client_id, token_hash,
       resource, scopes, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8)`,
    [
      input.organizationId,
      input.userId,
      input.connectionId,
      input.clientId,
      hashMcpSecret(accessToken),
      input.resource,
      input.scopes,
      new Date(Date.now() + ACCESS_TOKEN_SECONDS * 1000),
    ],
  );
  if (!input.includeRefresh) {
    return { accessToken, expiresIn: ACCESS_TOKEN_SECONDS, scope: input.scopes.join(" ") };
  }
  const refreshToken = mintBoundToken("rt", input.organizationId, input.userId);
  await client.query(
    `INSERT INTO mcp_refresh_tokens (
       family_id, organization_id, user_id, connection_id, client_id,
       token_hash, resource, scopes, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9)`,
    [
      input.familyId ?? randomUUID(),
      input.organizationId,
      input.userId,
      input.connectionId,
      input.clientId,
      hashMcpSecret(refreshToken),
      input.resource,
      input.scopes,
      new Date(Date.now() + REFRESH_TOKEN_SECONDS * 1000),
    ],
  );
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_SECONDS, scope: input.scopes.join(" ") };
}

export async function exchangeAuthorizationCode(input: Readonly<{
  code: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  codeVerifier: string;
}>): Promise<OAuthTokenSet> {
  const parsed = parseBoundToken(input.code, "ac");
  if (!parsed) throw new McpOAuthError("invalid_grant", "The authorization code is invalid");
  const context = oauthTenantContext(parsed.organizationId, parsed.userId, `mcp-token:${randomUUID()}`, "Exchange MCP authorization code");
  return withTenantTransaction(context, async (client) => {
    const result = await client.query<GrantRow>(
      `SELECT code.connection_id, code.client_id, code.redirect_uri,
         code.resource, code.scopes, code.code_challenge
       FROM mcp_oauth_codes code
       JOIN mcp_connections connection
         ON connection.organization_id = code.organization_id
        AND connection.id = code.connection_id
        AND connection.user_id = code.user_id
        AND connection.revoked_at IS NULL
       WHERE code.organization_id = $1 AND code.user_id = $2
         AND code.code_hash = $3 AND code.consumed_at IS NULL
         AND code.expires_at > now()
       FOR UPDATE OF code`,
      [parsed.organizationId, parsed.userId, hashMcpSecret(input.code)],
    );
    const grant = result.rows[0];
    if (!grant || grant.client_id !== input.clientId || grant.redirect_uri !== input.redirectUri ||
        grant.resource !== input.resource || !verifyPkceS256(input.codeVerifier, grant.code_challenge)) {
      throw new McpOAuthError("invalid_grant", "The authorization code, client, redirect URI, resource, or PKCE verifier is invalid");
    }
    await client.query(
      `UPDATE mcp_oauth_codes SET consumed_at = now()
       WHERE organization_id = $1 AND code_hash = $2 AND consumed_at IS NULL`,
      [parsed.organizationId, hashMcpSecret(input.code)],
    );
    return mintTokenSet(client, {
      organizationId: parsed.organizationId,
      userId: parsed.userId,
      connectionId: grant.connection_id,
      clientId: grant.client_id,
      resource: grant.resource,
      scopes: grant.scopes,
      includeRefresh: grant.scopes.includes("offline_access"),
    });
  });
}

type RefreshRow = Readonly<{
  id: string;
  family_id: string;
  connection_id: string;
  client_id: string;
  resource: string;
  scopes: string[];
  consumed_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
  connection_revoked_at: Date | null;
}>;

export async function exchangeRefreshToken(input: Readonly<{
  refreshToken: string;
  clientId: string;
  resource: string;
  requestedScopes?: readonly string[];
}>): Promise<OAuthTokenSet> {
  const parsed = parseBoundToken(input.refreshToken, "rt");
  if (!parsed) throw new McpOAuthError("invalid_grant", "The refresh token is invalid");
  const context = oauthTenantContext(parsed.organizationId, parsed.userId, `mcp-refresh:${randomUUID()}`, "Rotate MCP refresh token");
  const outcome = await withTenantTransaction(context, async (client) => {
    const result = await client.query<RefreshRow>(
      `SELECT token.id, token.family_id, token.connection_id, token.client_id,
         token.resource, token.scopes, token.consumed_at, token.revoked_at,
         token.expires_at, connection.revoked_at AS connection_revoked_at
       FROM mcp_refresh_tokens token
       JOIN mcp_connections connection
         ON connection.organization_id = token.organization_id
        AND connection.id = token.connection_id
        AND connection.user_id = token.user_id
       WHERE token.organization_id = $1 AND token.user_id = $2 AND token.token_hash = $3
       FOR UPDATE OF token`,
      [parsed.organizationId, parsed.userId, hashMcpSecret(input.refreshToken)],
    );
    const token = result.rows[0];
    if (!token || token.client_id !== input.clientId || token.resource !== input.resource ||
        token.connection_revoked_at || token.revoked_at || token.expires_at.getTime() <= Date.now()) {
      throw new McpOAuthError("invalid_grant", "The refresh token is expired, revoked, or bound to another client or resource");
    }
    if (token.consumed_at) {
      await client.query(
        `UPDATE mcp_refresh_tokens SET revoked_at = coalesce(revoked_at, now())
         WHERE organization_id = $1 AND family_id = $2`,
        [parsed.organizationId, token.family_id],
      );
      return { kind: "reuse-detected" as const };
    }
    const scopes = input.requestedScopes?.length ? [...new Set(input.requestedScopes)] : token.scopes;
    if (!isScopeSubset(scopes, token.scopes)) {
      throw new McpOAuthError("invalid_scope", "A refresh request cannot expand its original scopes");
    }
    await client.query(
      `UPDATE mcp_refresh_tokens SET consumed_at = now()
       WHERE organization_id = $1 AND id = $2 AND consumed_at IS NULL`,
      [parsed.organizationId, token.id],
    );
    const tokens = await mintTokenSet(client, {
      organizationId: parsed.organizationId,
      userId: parsed.userId,
      connectionId: token.connection_id,
      clientId: token.client_id,
      resource: token.resource,
      scopes,
      familyId: token.family_id,
      includeRefresh: true,
    });
    return { kind: "tokens" as const, tokens };
  });
  if (outcome.kind === "reuse-detected") {
    throw new McpOAuthError("invalid_grant", "Refresh-token reuse was detected and its token family was revoked");
  }
  return outcome.tokens;
}

type AccessTokenRow = Readonly<{
  connection_id: string;
  client_id: string;
  client_name: string;
  membership_id: string;
  organization_name: string;
  role_label: string;
  scopes: string[];
  resource: string;
  expires_at: Date;
  daily_mode: string;
  setup_mode: string;
  tool_overrides: unknown;
  writes_enabled: boolean;
}>;

export async function verifyAccessToken(rawToken: string, expectedResource: string): Promise<McpConnectionPrincipal> {
  const parsed = parseBoundToken(rawToken, "at");
  if (!parsed) throw new McpOAuthError("invalid_token", "The bearer token is malformed", 401);
  const context = oauthTenantContext(parsed.organizationId, parsed.userId, `mcp-auth:${randomUUID()}`, "Validate MCP access token");
  return withTenantTransaction(context, async (client) => {
    const result = await client.query<AccessTokenRow>(
      `SELECT token.connection_id, token.client_id, connection.client_name,
         connection.membership_id, organization.display_name AS organization_name,
         role.display_name AS role_label, token.scopes, token.resource,
         token.expires_at, connection.daily_mode, connection.setup_mode,
         connection.tool_overrides,
         (organization.writes_enabled_at IS NOT NULL) AS writes_enabled
       FROM mcp_access_tokens token
       JOIN mcp_connections connection
         ON connection.organization_id = token.organization_id
        AND connection.id = token.connection_id
        AND connection.user_id = token.user_id
        AND connection.client_id = token.client_id
        AND connection.revoked_at IS NULL
       JOIN organizations organization
         ON organization.id = token.organization_id AND organization.active
         AND NOT organization.is_demo AND organization.organization_mode = 'REAL'
       JOIN organization_memberships membership
         ON membership.organization_id = token.organization_id
        AND membership.id = connection.membership_id
        AND membership.user_id = token.user_id AND membership.active
       JOIN membership_roles membership_role
         ON membership_role.organization_id = membership.organization_id
        AND membership_role.membership_id = membership.id
       JOIN roles role
         ON role.organization_id = membership_role.organization_id
        AND role.id = membership_role.role_id AND role.active
       WHERE token.organization_id = $1 AND token.user_id = $2
         AND token.token_hash = $3 AND token.revoked_at IS NULL
         AND token.expires_at > now()
         AND app.mcp_user_is_active(token.user_id)
       ORDER BY role.key
       LIMIT 1`,
      [parsed.organizationId, parsed.userId, hashMcpSecret(rawToken)],
    );
    const token = result.rows[0];
    if (!token || token.resource !== expectedResource) {
      throw new McpOAuthError("invalid_token", "The bearer token is expired, revoked, or has the wrong audience", 401);
    }
    await client.query(
      `UPDATE mcp_connections SET last_used_at = now()
       WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL`,
      [parsed.organizationId, token.connection_id],
    );
    return {
      connectionId: token.connection_id,
      organizationId: parsed.organizationId,
      userId: parsed.userId,
      membershipId: token.membership_id,
      organizationName: token.organization_name,
      roleLabel: token.role_label,
      clientId: token.client_id,
      clientName: token.client_name,
      scopes: token.scopes,
      resource: token.resource,
      dailyMode: parseAccessMode(token.daily_mode),
      setupMode: parseAccessMode(token.setup_mode),
      toolOverrides: parseToolOverrides(token.tool_overrides),
      tokenExpiresAt: token.expires_at,
      organizationWritesEnabled: token.writes_enabled,
    };
  });
}

export async function revokeOAuthToken(rawToken: string, clientId?: string): Promise<void> {
  const parsed = parseBoundToken(rawToken);
  if (!parsed || (parsed.kind !== "at" && parsed.kind !== "rt")) return;
  const context = oauthTenantContext(parsed.organizationId, parsed.userId, `mcp-revoke:${randomUUID()}`, "Revoke MCP OAuth token");
  await withTenantTransaction(context, async (client) => {
    if (parsed.kind === "at") {
      await client.query(
        `UPDATE mcp_access_tokens SET revoked_at = coalesce(revoked_at, now())
         WHERE organization_id = $1 AND user_id = $2 AND token_hash = $3
           AND ($4::text IS NULL OR client_id = $4)`,
        [parsed.organizationId, parsed.userId, hashMcpSecret(rawToken), clientId ?? null],
      );
      return;
    }
    const refresh = await client.query<{ family_id: string }>(
      `SELECT family_id FROM mcp_refresh_tokens
       WHERE organization_id = $1 AND user_id = $2 AND token_hash = $3
         AND ($4::text IS NULL OR client_id = $4)`,
      [parsed.organizationId, parsed.userId, hashMcpSecret(rawToken), clientId ?? null],
    );
    if (refresh.rows[0]) {
      await client.query(
        `UPDATE mcp_refresh_tokens SET revoked_at = coalesce(revoked_at, now())
         WHERE organization_id = $1 AND family_id = $2`,
        [parsed.organizationId, refresh.rows[0].family_id],
      );
    }
  });
}

export function mcpSessionPrincipal(
  principal: McpConnectionPrincipal,
  stepUpExpiresAt?: string,
): SessionPrincipal {
  const delegatedStepUpExpiry = stepUpExpiresAt ? new Date(stepUpExpiresAt) : null;
  return {
    sessionId: principal.connectionId,
    userId: principal.userId,
    organizationId: principal.organizationId,
    membershipId: principal.membershipId,
    organizationName: principal.organizationName,
    roleLabel: principal.roleLabel,
    displayName: "Connected accounting user",
    initials: "AI",
    sessionMode: "real",
    authMethod: "PASSWORD",
    expiresAt: principal.tokenExpiresAt,
    mfaVerifiedAt: delegatedStepUpExpiry ? new Date(delegatedStepUpExpiry.getTime() - 10 * 60 * 1000) : null,
    stepUpExpiresAt: delegatedStepUpExpiry,
    organizationWritesEnabled: principal.organizationWritesEnabled,
  };
}

export function mcpMutationContext(
  principal: McpConnectionPrincipal,
  requestId: string,
  reason?: string,
): TenantTransactionContext {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.connectionId,
    sessionMode: "real",
    requestId,
    authMethod: "oauth2.1+pkce",
    sourceSurface: "MCP",
    reason,
  };
}
