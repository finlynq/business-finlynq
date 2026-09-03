import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const MCP_OAUTH_SCOPES = {
  dailyRead: "mcp:daily:read",
  dailyWrite: "mcp:daily:write",
  setupRead: "mcp:setup:read",
  setupWrite: "mcp:setup:write",
  offlineAccess: "offline_access",
} as const;

export const MCP_SUPPORTED_SCOPES = Object.values(MCP_OAUTH_SCOPES);

export type McpOAuthScope = (typeof MCP_SUPPORTED_SCOPES)[number];
export type McpToolGroup = "DAILY" | "SETUP" | "SHARED";
export type McpAccessMode = "OFF" | "READ_ONLY" | "CONFIRM_WRITES" | "ALLOW_WRITES";
export type McpToolOverride = McpAccessMode | "INHERIT";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const opaqueSecretPattern = /^[A-Za-z0-9_-]{43}$/;
const codeVerifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;

export class McpOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "McpOAuthError";
  }
}

export type BoundTokenKind = "ac" | "at" | "rt";

export type ParsedBoundToken = Readonly<{
  kind: BoundTokenKind;
  organizationId: string;
  userId: string;
  secret: string;
}>;

export function mintBoundToken(
  kind: BoundTokenKind,
  organizationId: string,
  userId: string,
): string {
  if (!uuidPattern.test(organizationId) || !uuidPattern.test(userId)) {
    throw new Error("OAuth tokens require UUID-bound user and organization identifiers");
  }
  return `mcp_${kind}.${organizationId}.${userId}.${randomBytes(32).toString("base64url")}`;
}

export function parseBoundToken(raw: string, expectedKind?: BoundTokenKind): ParsedBoundToken | null {
  if (raw.length < 100 || raw.length > 180) return null;
  const [prefix, organizationId, userId, secret, ...extra] = raw.split(".");
  if (extra.length > 0 || !prefix || !organizationId || !userId || !secret) return null;
  const match = /^mcp_(ac|at|rt)$/.exec(prefix);
  if (!match) return null;
  const kind = match[1] as BoundTokenKind;
  if (expectedKind && kind !== expectedKind) return null;
  if (!uuidPattern.test(organizationId) || !uuidPattern.test(userId) || !opaqueSecretPattern.test(secret)) return null;
  return { kind, organizationId, userId, secret };
}

export function hashMcpSecret(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function verifyPkceS256(verifier: string, expectedChallenge: string): boolean {
  if (!codeVerifierPattern.test(verifier) || !opaqueSecretPattern.test(expectedChallenge)) return false;
  const actual = createHash("sha256").update(verifier, "utf8").digest("base64url");
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expectedChallenge, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function parseRequestedScopes(raw: string | null | undefined): McpOAuthScope[] {
  const requested = [...new Set((raw ?? "").split(/\s+/).map((scope) => scope.trim()).filter(Boolean))];
  if (requested.length === 0) return [MCP_OAUTH_SCOPES.dailyRead];
  const allowed = new Set<string>(MCP_SUPPORTED_SCOPES);
  if (requested.some((scope) => !allowed.has(scope))) {
    throw new McpOAuthError("invalid_scope", "One or more requested scopes are not supported");
  }
  if (requested.includes(MCP_OAUTH_SCOPES.dailyWrite) && !requested.includes(MCP_OAUTH_SCOPES.dailyRead)) {
    throw new McpOAuthError("invalid_scope", "Daily write access requires daily read access");
  }
  if (requested.includes(MCP_OAUTH_SCOPES.setupWrite) && !requested.includes(MCP_OAUTH_SCOPES.setupRead)) {
    throw new McpOAuthError("invalid_scope", "Setup write access requires setup read access");
  }
  return requested as McpOAuthScope[];
}

export function isScopeSubset(requested: readonly string[], granted: readonly string[]): boolean {
  const grant = new Set(granted);
  return requested.every((scope) => grant.has(scope));
}

const accessModeSchema = z.enum(["OFF", "READ_ONLY", "CONFIRM_WRITES", "ALLOW_WRITES"]);
const toolOverrideSchema = z.enum(["INHERIT", "OFF", "READ_ONLY", "CONFIRM_WRITES", "ALLOW_WRITES"]);

export function parseAccessMode(value: unknown): McpAccessMode {
  return accessModeSchema.parse(value);
}

export function parseToolOverrides(value: unknown): Record<string, McpToolOverride> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, McpToolOverride> = {};
  for (const [name, mode] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) continue;
    const parsed = toolOverrideSchema.safeParse(mode);
    if (parsed.success) output[name] = parsed.data;
  }
  return output;
}

export function oauthPublicOrigin(requestUrl?: string): URL {
  const configured = process.env.BUSINESS_FINLYNQ_PUBLIC_URL?.trim() || process.env.APP_ORIGIN?.trim();
  const origin = new URL(configured || requestUrl || "http://localhost:3000");
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
  if (process.env.NODE_ENV === "production" && origin.protocol !== "https:") {
    throw new Error("BUSINESS_FINLYNQ_PUBLIC_URL must use HTTPS in production");
  }
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) {
    throw new Error("MCP OAuth permits HTTP only for local development");
  }
  return origin;
}

export function mcpResourceUrl(requestUrl?: string): URL {
  return new URL("/mcp", oauthPublicOrigin(requestUrl));
}

export function authorizationServerMetadata(requestUrl?: string) {
  const origin = oauthPublicOrigin(requestUrl);
  return {
    issuer: origin.origin,
    authorization_endpoint: new URL("/oauth/authorize", origin).href,
    token_endpoint: new URL("/oauth/token", origin).href,
    registration_endpoint: new URL("/oauth/register", origin).href,
    revocation_endpoint: new URL("/oauth/revoke", origin).href,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: MCP_SUPPORTED_SCOPES,
  } as const;
}

export function noStoreJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("access-control-allow-origin", "*");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function oauthErrorResponse(error: unknown): Response {
  if (error instanceof McpOAuthError) {
    return noStoreJson({ error: error.code, error_description: error.message }, { status: error.status });
  }
  return noStoreJson({ error: "server_error", error_description: "The authorization server could not complete the request" }, { status: 500 });
}
