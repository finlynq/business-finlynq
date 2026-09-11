import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { NextResponse } from "next/server";
import { z } from "zod";
import { configuredAppOrigin } from "./request-security";
import { safeAppPath } from "./safe-redirect";
import { decryptAuthPayload, encryptAuthPayload } from "@/security/identity-secret";

type OidcEnvironment = Readonly<Record<string, string | undefined>>;

const LOGIN_TTL_SECONDS = 5 * 60;
const SIGNUP_PROOF_TTL_SECONDS = 15 * 60;
const MAXIMUM_MAP_BYTES = 2 * 1024 * 1024;
const PORTABLE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAP_SCHEMA_VERSION = "business-finlynq-oidc-identity-map/v1";
const noControlCharacters = /^[^\u0000-\u001f\u007f]+$/;

const loginAttemptSchema = z.object({
  version: z.literal(2),
  state: z.string().regex(OPAQUE_TOKEN),
  nonce: z.string().regex(OPAQUE_TOKEN),
  verifier: z.string().regex(OPAQUE_TOKEN),
  next: z.string().max(2_000),
  intent: z.enum(["login", "signup", "signup-accept"]),
  issuedAt: z.number().int().nonnegative(),
  configurationHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const signupProofSchema = z.object({
  version: z.literal(1),
  issuer: z.string().url().max(2_048),
  externalTenantId: z.string().regex(PORTABLE_IDENTIFIER),
  externalPrincipalId: z.string().regex(PORTABLE_IDENTIFIER),
  credentialHash: z.string().regex(/^[0-9a-f]{64}$/),
  issuedAt: z.number().int().nonnegative(),
  configurationHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type OidcMappedIdentity = Readonly<{
  userId: string;
  organizationId: string;
  membershipId: string;
}>;

type IdentityMapEntry = OidcMappedIdentity & Readonly<{
  issuer: string;
  externalTenantId: string;
  externalPrincipalId: string;
}>;

export type OidcConfiguration = Readonly<{
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedTenants: ReadonlySet<string>;
  identityMap: ReadonlyMap<string, IdentityMapEntry>;
  maximumTokenLifetimeSeconds: number;
  tokenTimeoutMilliseconds: number;
  jwksTimeoutMilliseconds: number;
  configurationHash: string;
}>;

export type VerifiedOidcIdentity = OidcMappedIdentity & Readonly<{
  externalTenantId: string;
  externalPrincipalId: string;
  credentialHash: string;
}>;

export type VerifiedOidcPrincipal = Readonly<{
  issuer: string;
  externalTenantId: string;
  externalPrincipalId: string;
  credentialHash: string;
  mappedIdentity: OidcMappedIdentity | null;
}>;

export type OidcSignupProof = Readonly<{
  issuer: string;
  externalTenantId: string;
  externalPrincipalId: string;
  credentialHash: string;
}>;

export type OidcIntent = "login" | "signup" | "signup-accept";

export class OidcAuthenticationError extends Error {
  constructor(public readonly code: string) {
    super(`OIDC authentication failed (${code})`);
    this.name = "OidcAuthenticationError";
  }
}

function fail(code: string): never {
  throw new OidcAuthenticationError(code);
}

function exactBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "") return false;
  if (value !== "true" && value !== "false") throw new Error(`${name} must be exactly true or false`);
  return value === "true";
}

export function oidcLoginEnabled(environment: OidcEnvironment = process.env): boolean {
  return environment.ACCOUNT_LOGIN_ENABLED === "true" && environment.AUTH_OIDC_ENABLED === "true";
}

export function oidcSignupEnabled(environment: OidcEnvironment = process.env): boolean {
  return oidcLoginEnabled(environment) && environment.AUTH_OIDC_SIGNUP_ENABLED === "true";
}

function required(value: string | undefined, name: string, maximum = 4_096): string {
  const selected = value?.trim();
  if (!selected || selected.length > maximum || !noControlCharacters.test(selected)) {
    throw new Error(`${name} must be a bounded nonempty value`);
  }
  return selected;
}

function httpsEndpoint(value: string | undefined, name: string): string {
  const selected = new URL(required(value, name));
  if (
    selected.protocol !== "https:" || selected.username || selected.password ||
    selected.search || selected.hash
  ) {
    throw new Error(`${name} must be an HTTPS endpoint without credentials, query parameters, or a fragment`);
  }
  return selected.toString();
}

function boundedInteger(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${name} must be an integer`);
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return selected;
}

function loadOneLineSecret(
  environment: OidcEnvironment,
  readTextFile: (path: string) => string,
): string {
  const file = environment.AUTH_OIDC_CLIENT_SECRET_FILE?.trim();
  const inline = environment.AUTH_OIDC_CLIENT_SECRET?.trim();
  if (file && inline) throw new Error("Configure only one OIDC client-secret source");
  let selected: string;
  if (file) {
    try {
      selected = readTextFile(file).trim();
    } catch (error) {
      throw new Error("Unable to load the OIDC client-secret file", { cause: error });
    }
  } else if (inline && environment.NODE_ENV !== "production") {
    selected = inline;
  } else if (inline) {
    throw new Error("Production requires AUTH_OIDC_CLIENT_SECRET_FILE");
  } else {
    throw new Error("AUTH_OIDC_CLIENT_SECRET_FILE is required");
  }
  if (selected.length < 16 || selected.length > 4_096 || /[\r\n\0]/.test(selected)) {
    throw new Error("The OIDC client secret must contain one bounded value");
  }
  return selected;
}

function canonicalIssuer(value: unknown, path: string): string {
  if (typeof value !== "string" || value !== value.trim()) throw new Error(`${path} must be an exact HTTPS URL`);
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${path} must be an exact HTTPS URL`);
  }
  return parsed.toString();
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !PORTABLE_IDENTIFIER.test(value)) {
    throw new Error(`${path} must be a portable identifier`);
  }
  return value;
}

function uuid(value: unknown, path: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${path} must be a UUID`);
  return value.toLowerCase();
}

function sourceKey(issuer: string, externalTenantId: string, externalPrincipalId: string): string {
  return `${issuer}\0${externalTenantId}\0${externalPrincipalId}`;
}

export function parseOidcIdentityMap(input: string): readonly IdentityMapEntry[] {
  if (Buffer.byteLength(input, "utf8") > MAXIMUM_MAP_BYTES) throw new Error("OIDC identity map is too large");
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    throw new Error("OIDC identity map must contain strict JSON", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OIDC identity map must be an object");
  const root = value as Record<string, unknown>;
  if (Object.keys(root).some((key) => key !== "schemaVersion" && key !== "mappings")) {
    throw new Error("OIDC identity map contains an unknown root field");
  }
  if (root.schemaVersion !== MAP_SCHEMA_VERSION) throw new Error(`OIDC identity map must use ${MAP_SCHEMA_VERSION}`);
  if (!Array.isArray(root.mappings) || root.mappings.length > 1_000) {
    throw new Error("OIDC identity map must contain at most 1000 mappings");
  }
  const entries = root.mappings.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`OIDC identity map mappings[${index}] must be an object`);
    }
    const entry = value as Record<string, unknown>;
    const allowedKeys = new Set([
      "issuer", "externalTenantId", "externalPrincipalId", "userId", "organizationId", "membershipId",
    ]);
    if (Object.keys(entry).some((key) => !allowedKeys.has(key))) {
      throw new Error(`OIDC identity map mappings[${index}] contains an unknown field`);
    }
    return Object.freeze({
      issuer: canonicalIssuer(entry.issuer, `mappings[${index}].issuer`),
      externalTenantId: identifier(entry.externalTenantId, `mappings[${index}].externalTenantId`),
      externalPrincipalId: identifier(entry.externalPrincipalId, `mappings[${index}].externalPrincipalId`),
      userId: uuid(entry.userId, `mappings[${index}].userId`),
      organizationId: uuid(entry.organizationId, `mappings[${index}].organizationId`),
      membershipId: uuid(entry.membershipId, `mappings[${index}].membershipId`),
    });
  });
  const sourceKeys = entries.map((entry) => sourceKey(entry.issuer, entry.externalTenantId, entry.externalPrincipalId));
  if (new Set(sourceKeys).size !== entries.length) throw new Error("OIDC identity map contains a duplicate external identity");
  const targetKeys = entries.map((entry) => `${entry.userId}\0${entry.organizationId}\0${entry.membershipId}`);
  if (new Set(targetKeys).size !== entries.length) throw new Error("OIDC identity map contains a duplicate Business identity");
  return Object.freeze(entries);
}

function loadIdentityMap(
  environment: OidcEnvironment,
  readTextFile: (path: string) => string,
): readonly IdentityMapEntry[] {
  const file = environment.AUTH_OIDC_IDENTITY_MAP_FILE?.trim();
  const inline = environment.AUTH_OIDC_IDENTITY_MAP?.trim();
  if (file && inline) throw new Error("Configure only one OIDC identity-map source");
  if (file) {
    try {
      return parseOidcIdentityMap(readTextFile(file));
    } catch (error) {
      throw new Error("Unable to load the OIDC identity-map file", { cause: error });
    }
  }
  if (inline && environment.NODE_ENV !== "production") return parseOidcIdentityMap(inline);
  if (inline) throw new Error("Production requires AUTH_OIDC_IDENTITY_MAP_FILE");
  throw new Error("AUTH_OIDC_IDENTITY_MAP_FILE is required");
}

export function loadOidcConfiguration(
  environment: OidcEnvironment = process.env,
  readTextFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): OidcConfiguration {
  if (!exactBoolean(environment.AUTH_OIDC_ENABLED, "AUTH_OIDC_ENABLED")) {
    throw new Error("OIDC sign-in is disabled");
  }
  if (environment.ACCOUNT_LOGIN_ENABLED !== "true") {
    throw new Error("OIDC sign-in requires real-account login");
  }
  const issuer = httpsEndpoint(environment.AUTH_OIDC_ISSUER, "AUTH_OIDC_ISSUER");
  const authorizationEndpoint = httpsEndpoint(
    environment.AUTH_OIDC_AUTHORIZATION_ENDPOINT,
    "AUTH_OIDC_AUTHORIZATION_ENDPOINT",
  );
  const tokenEndpoint = httpsEndpoint(environment.AUTH_OIDC_TOKEN_ENDPOINT, "AUTH_OIDC_TOKEN_ENDPOINT");
  const jwksUri = httpsEndpoint(environment.AUTH_OIDC_JWKS_URI, "AUTH_OIDC_JWKS_URI");
  if (new URL(authorizationEndpoint).origin !== new URL(tokenEndpoint).origin ||
      new URL(authorizationEndpoint).origin !== new URL(jwksUri).origin) {
    throw new Error("OIDC authorization, token, and JWKS endpoints must share one trusted origin");
  }
  const clientId = required(environment.AUTH_OIDC_CLIENT_ID, "AUTH_OIDC_CLIENT_ID", 512);
  const clientSecret = loadOneLineSecret(environment, readTextFile);
  const allowedTenantValues = required(
    environment.AUTH_OIDC_ALLOWED_TENANTS,
    "AUTH_OIDC_ALLOWED_TENANTS",
    25_600,
  ).split(",").map((value) => identifier(value.trim(), "AUTH_OIDC_ALLOWED_TENANTS"));
  if (allowedTenantValues.length > 100) throw new Error("AUTH_OIDC_ALLOWED_TENANTS permits at most 100 entries");
  const allowedTenants = new Set(allowedTenantValues);
  const identityEntries = loadIdentityMap(environment, readTextFile);
  const identityMap = new Map<string, IdentityMapEntry>();
  for (const entry of identityEntries) {
    if (entry.issuer !== issuer) throw new Error("Every OIDC identity-map issuer must match AUTH_OIDC_ISSUER");
    if (!allowedTenants.has(entry.externalTenantId)) {
      throw new Error("Every OIDC identity-map tenant must be explicitly allowed");
    }
    identityMap.set(sourceKey(entry.issuer, entry.externalTenantId, entry.externalPrincipalId), entry);
  }
  const redirectUri = new URL("/api/auth/oidc/callback", configuredAppOrigin(environment)).toString();
  const configurationHash = createHash("sha256")
    .update([issuer, authorizationEndpoint, tokenEndpoint, jwksUri, clientId, redirectUri].join("\0"), "utf8")
    .digest("hex");
  return Object.freeze({
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    clientId,
    clientSecret,
    redirectUri,
    allowedTenants,
    identityMap,
    maximumTokenLifetimeSeconds: boundedInteger(
      environment.AUTH_OIDC_MAXIMUM_TOKEN_LIFETIME_SECONDS,
      "AUTH_OIDC_MAXIMUM_TOKEN_LIFETIME_SECONDS",
      60,
      86_400,
      7_200,
    ),
    tokenTimeoutMilliseconds: boundedInteger(
      environment.AUTH_OIDC_TOKEN_TIMEOUT_MILLISECONDS,
      "AUTH_OIDC_TOKEN_TIMEOUT_MILLISECONDS",
      100,
      60_000,
      10_000,
    ),
    jwksTimeoutMilliseconds: boundedInteger(
      environment.AUTH_OIDC_JWKS_TIMEOUT_MILLISECONDS,
      "AUTH_OIDC_JWKS_TIMEOUT_MILLISECONDS",
      100,
      60_000,
      5_000,
    ),
    configurationHash,
  });
}

function opaqueToken(random: (size: number) => Buffer = randomBytes): string {
  const value = random(32);
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error("OIDC random source returned an invalid value");
  return value.toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createOidcAuthorization(
  configuration: OidcConfiguration,
  next: string | null | undefined,
  options: Readonly<{
    now?: number;
    random?: (size: number) => Buffer;
    intent?: OidcIntent;
  }> = {},
): { location: string; loginCookie: string } {
  const state = opaqueToken(options.random);
  const nonce = opaqueToken(options.random);
  const verifier = opaqueToken(options.random);
  const loginCookie = encryptAuthPayload(JSON.stringify({
    version: 2,
    state,
    nonce,
    verifier,
    next: safeAppPath(next),
    intent: options.intent ?? "login",
    issuedAt: options.now ?? Date.now(),
    configurationHash: configuration.configurationHash,
  }), "oidc-login", "oidc-login");
  const location = new URL(configuration.authorizationEndpoint);
  location.searchParams.set("response_type", "code");
  location.searchParams.set("response_mode", "query");
  location.searchParams.set("client_id", configuration.clientId);
  location.searchParams.set("redirect_uri", configuration.redirectUri);
  location.searchParams.set("scope", "openid profile email");
  location.searchParams.set("state", state);
  location.searchParams.set("nonce", nonce);
  location.searchParams.set("code_challenge", digest(verifier));
  location.searchParams.set("code_challenge_method", "S256");
  return { location: location.toString(), loginCookie };
}

export function consumeOidcLoginAttempt(
  encryptedAttempt: string | undefined,
  state: string | null,
  configuration: OidcConfiguration,
  now = Date.now(),
): Readonly<{ nonce: string; verifier: string; next: string; intent: OidcIntent }> {
  if (!encryptedAttempt || encryptedAttempt.length > 4_096 || !state || !OPAQUE_TOKEN.test(state)) {
    fail("state_invalid");
  }
  let parsed: z.infer<typeof loginAttemptSchema>;
  try {
    parsed = loginAttemptSchema.parse(JSON.parse(
      decryptAuthPayload(encryptedAttempt, "oidc-login", "oidc-login"),
    ));
  } catch {
    fail("state_invalid");
  }
  if (!sameSecret(parsed.state, state) || !sameSecret(parsed.configurationHash, configuration.configurationHash)) {
    fail("state_invalid");
  }
  if (parsed.issuedAt > now + 30_000 || now - parsed.issuedAt > LOGIN_TTL_SECONDS * 1_000) {
    fail("state_expired");
  }
  return Object.freeze({
    nonce: parsed.nonce,
    verifier: parsed.verifier,
    next: safeAppPath(parsed.next),
    intent: parsed.intent,
  });
}

function formEncodedComponent(value: string): string {
  const encoded = new URLSearchParams([["value", value]]).toString();
  return encoded.slice("value=".length);
}

export async function exchangeOidcAuthorizationCode(
  configuration: OidcConfiguration,
  code: string,
  verifier: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<string> {
  if (!/^[\x21-\x7e]{1,4096}$/.test(code) || !OPAQUE_TOKEN.test(verifier)) fail("code_invalid");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: configuration.redirectUri,
    code_verifier: verifier,
  });
  let response: Response;
  try {
    response = await fetchImplementation(configuration.tokenEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(
          `${formEncodedComponent(configuration.clientId)}:${formEncodedComponent(configuration.clientSecret)}`,
          "utf8",
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(configuration.tokenTimeoutMilliseconds),
    });
  } catch {
    fail("token_unavailable");
  }
  if (!response.ok) fail("code_rejected");
  let text: string;
  try {
    text = await response.text();
  } catch {
    fail("token_unavailable");
  }
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) fail("token_invalid");
  let bodyValue: unknown;
  try {
    bodyValue = JSON.parse(text);
  } catch {
    fail("token_invalid");
  }
  const idToken = bodyValue && typeof bodyValue === "object" && !Array.isArray(bodyValue)
    ? (bodyValue as Record<string, unknown>).id_token
    : null;
  if (typeof idToken !== "string" || idToken.length < 100 || idToken.length > 32 * 1024) {
    fail("token_invalid");
  }
  return idToken;
}

const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(configuration: OidcConfiguration): ReturnType<typeof createRemoteJWKSet> {
  let selected = remoteJwks.get(configuration.jwksUri);
  if (!selected) {
    selected = createRemoteJWKSet(new URL(configuration.jwksUri), {
      timeoutDuration: configuration.jwksTimeoutMilliseconds,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    remoteJwks.set(configuration.jwksUri, selected);
  }
  return selected;
}

export async function verifyOidcPrincipal(
  configuration: OidcConfiguration,
  idToken: string,
  expectedNonce: string,
  keyResolver: JWTVerifyGetKey = jwksFor(configuration),
): Promise<VerifiedOidcPrincipal> {
  let payload: JWTPayload;
  let protectedHeader: Readonly<Record<string, unknown>>;
  try {
    const verified = await jwtVerify(idToken, keyResolver, {
      algorithms: ["RS256"],
      issuer: configuration.issuer,
      audience: configuration.clientId,
      clockTolerance: 30,
      requiredClaims: ["exp", "iat", "iss", "aud", "nonce", "tid", "oid"],
    });
    payload = verified.payload;
    protectedHeader = verified.protectedHeader;
  } catch {
    fail("token_rejected");
  }
  if (protectedHeader.alg !== "RS256" || protectedHeader.crit !== undefined ||
      protectedHeader.jku !== undefined || protectedHeader.x5u !== undefined ||
      (protectedHeader.typ !== undefined && protectedHeader.typ !== "JWT")) {
    fail("token_rejected");
  }
  if (typeof payload.nonce !== "string" || !sameSecret(payload.nonce, expectedNonce)) fail("nonce_mismatch");
  const now = Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
      payload.iat! > now + 30 || payload.exp! <= payload.iat! ||
      payload.exp! - payload.iat! > configuration.maximumTokenLifetimeSeconds) {
    fail("token_lifetime");
  }
  if ((Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== configuration.clientId) ||
      (payload.azp !== undefined && payload.azp !== configuration.clientId)) {
    fail("token_rejected");
  }
  let externalTenantId: string;
  let externalPrincipalId: string;
  try {
    externalTenantId = identifier(payload.tid, "OIDC tid claim");
    externalPrincipalId = identifier(payload.oid, "OIDC oid claim");
  } catch {
    fail("token_rejected");
  }
  if (!configuration.allowedTenants.has(externalTenantId)) fail("tenant_denied");
  const mapped = configuration.identityMap.get(
    sourceKey(configuration.issuer, externalTenantId, externalPrincipalId),
  );
  const credentialHash = createHash("sha256")
    .update([configuration.issuer, configuration.clientId, externalTenantId, externalPrincipalId].join("\0"), "utf8")
    .digest("hex");
  return Object.freeze({
    issuer: configuration.issuer,
    externalTenantId,
    externalPrincipalId,
    credentialHash,
    mappedIdentity: mapped
      ? Object.freeze({
          userId: mapped.userId,
          organizationId: mapped.organizationId,
          membershipId: mapped.membershipId,
        })
      : null,
  });
}

export async function verifyOidcIdToken(
  configuration: OidcConfiguration,
  idToken: string,
  expectedNonce: string,
  keyResolver: JWTVerifyGetKey = jwksFor(configuration),
): Promise<VerifiedOidcIdentity> {
  const principal = await verifyOidcPrincipal(configuration, idToken, expectedNonce, keyResolver);
  if (!principal.mappedIdentity) fail("identity_unassigned");
  return Object.freeze({
    ...principal.mappedIdentity,
    externalTenantId: principal.externalTenantId,
    externalPrincipalId: principal.externalPrincipalId,
    credentialHash: principal.credentialHash,
  });
}

export function createOidcSignupProof(
  configuration: OidcConfiguration,
  principal: VerifiedOidcPrincipal,
  now = Date.now(),
): string {
  return encryptAuthPayload(JSON.stringify({
    version: 1,
    issuer: principal.issuer,
    externalTenantId: principal.externalTenantId,
    externalPrincipalId: principal.externalPrincipalId,
    credentialHash: principal.credentialHash,
    issuedAt: now,
    configurationHash: configuration.configurationHash,
  }), "oidc-signup", "oidc-signup");
}

export function consumeOidcSignupProof(
  encryptedProof: string | undefined,
  configuration: OidcConfiguration,
  now = Date.now(),
): OidcSignupProof {
  if (!encryptedProof || encryptedProof.length > 4_096) fail("signup_proof_invalid");
  let parsed: z.infer<typeof signupProofSchema>;
  try {
    parsed = signupProofSchema.parse(JSON.parse(
      decryptAuthPayload(encryptedProof, "oidc-signup", "oidc-signup"),
    ));
  } catch {
    fail("signup_proof_invalid");
  }
  if (!sameSecret(parsed.configurationHash, configuration.configurationHash) ||
      parsed.issuer !== configuration.issuer ||
      !configuration.allowedTenants.has(parsed.externalTenantId)) {
    fail("signup_proof_invalid");
  }
  if (parsed.issuedAt > now + 30_000 || now - parsed.issuedAt > SIGNUP_PROOF_TTL_SECONDS * 1_000) {
    fail("signup_proof_expired");
  }
  return Object.freeze({
    issuer: parsed.issuer,
    externalTenantId: parsed.externalTenantId,
    externalPrincipalId: parsed.externalPrincipalId,
    credentialHash: parsed.credentialHash,
  });
}

export function oidcLoginCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? "__Host-business_finlynq_oidc_login"
    : "business_finlynq_oidc_login";
}

export function setOidcLoginCookie(response: NextResponse, value: string): void {
  response.cookies.set(oidcLoginCookieName(), value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: LOGIN_TTL_SECONDS,
    priority: "high",
  });
}

export function clearOidcLoginCookie(response: NextResponse): void {
  response.cookies.set(oidcLoginCookieName(), "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    priority: "high",
  });
}

export function oidcSignupCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? "__Host-business_finlynq_oidc_signup"
    : "business_finlynq_oidc_signup";
}

export function setOidcSignupCookie(response: NextResponse, value: string): void {
  response.cookies.set(oidcSignupCookieName(), value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SIGNUP_PROOF_TTL_SECONDS,
    priority: "high",
  });
}

export function clearOidcSignupCookie(response: NextResponse): void {
  response.cookies.set(oidcSignupCookieName(), "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    priority: "high",
  });
}
