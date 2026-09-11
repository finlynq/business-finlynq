import { createHash } from "node:crypto";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeOidcLoginAttempt,
  consumeOidcSignupProof,
  createOidcAuthorization,
  createOidcSignupProof,
  exchangeOidcAuthorizationCode,
  loadOidcConfiguration,
  parseOidcIdentityMap,
  verifyOidcIdToken,
  verifyOidcPrincipal,
} from "@/modules/identity/oidc";

const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  organization: "10000000-0000-4000-8000-000000000002",
  membership: "10000000-0000-4000-8000-000000000003",
};
const issuer = "https://tenant.example.test/tenant/v2.0";
const tenantId = "external-tenant";
const principalId = "external-principal";
const identityMap = JSON.stringify({
  schemaVersion: "business-finlynq-oidc-identity-map/v1",
  mappings: [{
    issuer,
    externalTenantId: tenantId,
    externalPrincipalId: principalId,
    userId: ids.user,
    organizationId: ids.organization,
    membershipId: ids.membership,
  }],
});
const identitySecret = Buffer.alloc(64, 11).toString("base64");

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "test",
    ACCOUNT_LOGIN_ENABLED: "true",
    AUTH_OIDC_ENABLED: "true",
    AUTH_OIDC_ISSUER: issuer,
    AUTH_OIDC_AUTHORIZATION_ENDPOINT: "https://login.example.test/tenant/oauth2/v2.0/authorize",
    AUTH_OIDC_TOKEN_ENDPOINT: "https://login.example.test/tenant/oauth2/v2.0/token",
    AUTH_OIDC_JWKS_URI: "https://login.example.test/tenant/discovery/v2.0/keys",
    AUTH_OIDC_CLIENT_ID: "business-client-id",
    AUTH_OIDC_CLIENT_SECRET: "test-client-secret-with-entropy",
    AUTH_OIDC_ALLOWED_TENANTS: tenantId,
    AUTH_OIDC_IDENTITY_MAP: identityMap,
    APP_ORIGIN: "https://business.example.test",
    ...overrides,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("Business OIDC configuration and browser-bound authorization", () => {
  it("loads only explicit trusted endpoints, tenants, and identity mappings", () => {
    const configuration = loadOidcConfiguration(environment());
    expect(configuration.redirectUri).toBe("https://business.example.test/api/auth/oidc/callback");
    expect(configuration.identityMap.size).toBe(1);
    expect(() => loadOidcConfiguration(environment({
      AUTH_OIDC_TOKEN_ENDPOINT: "https://other.example.test/token",
    }))).toThrow(/share one trusted origin/);
    expect(() => loadOidcConfiguration(environment({ NODE_ENV: "production" }))).toThrow(
      /AUTH_OIDC_CLIENT_SECRET_FILE/,
    );
  });

  it("rejects duplicate source and target mappings", () => {
    const parsed = JSON.parse(identityMap) as { mappings: unknown[] } & Record<string, unknown>;
    parsed.mappings.push(parsed.mappings[0]);
    expect(() => parseOidcIdentityMap(JSON.stringify(parsed))).toThrow(/duplicate external identity/);
  });

  it("binds state, nonce, PKCE verifier, redirect, and expiry to an encrypted browser cookie", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("IDENTITY_SECRET_FILE", "");
    vi.stubEnv("IDENTITY_SECRET", identitySecret);
    const configuration = loadOidcConfiguration(environment());
    let sequence = 0;
    const startedAt = Date.parse("2026-09-11T12:00:00Z");
    const authorization = createOidcAuthorization(
      configuration,
      "/app/receivables?status=open",
      { now: startedAt, random: (size) => Buffer.alloc(size, ++sequence) },
    );
    const location = new URL(authorization.location);
    const state = location.searchParams.get("state");
    const verifier = Buffer.alloc(32, 3).toString("base64url");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("response_mode")).toBe("query");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(authorization.loginCookie).not.toContain(state!);
    expect(consumeOidcLoginAttempt(
      authorization.loginCookie,
      state,
      configuration,
      startedAt + 60_000,
    )).toMatchObject({
      verifier,
      next: "/app/receivables?status=open",
      intent: "login",
    });
    const signupAuthorization = createOidcAuthorization(
      configuration,
      "/app",
      { now: startedAt, random: (size) => Buffer.alloc(size, 7), intent: "signup" },
    );
    expect(consumeOidcLoginAttempt(
      signupAuthorization.loginCookie,
      new URL(signupAuthorization.location).searchParams.get("state"),
      configuration,
      startedAt,
    ).intent).toBe("signup");
    expect(() => consumeOidcLoginAttempt(
      authorization.loginCookie,
      Buffer.alloc(32, 9).toString("base64url"),
      configuration,
      startedAt + 60_000,
    )).toThrow(/state_invalid/);
    expect(() => consumeOidcLoginAttempt(
      authorization.loginCookie,
      state,
      configuration,
      startedAt + 301_000,
    )).toThrow(/state_expired/);
  });
});

describe("OIDC code exchange and identity verification", () => {
  it("uses confidential-client authentication and PKCE for the bounded token exchange", async () => {
    const configuration = loadOidcConfiguration(environment());
    const verifier = Buffer.alloc(32, 3).toString("base64url");
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Basic /);
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("redirect_uri")).toBe(configuration.redirectUri);
      expect(body.get("code_verifier")).toBe(verifier);
      return Response.json({ id_token: "x".repeat(100) });
    });
    await expect(exchangeOidcAuthorizationCode(
      configuration,
      "authorization-code",
      verifier,
      fetcher,
    )).resolves.toBe("x".repeat(100));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts only a signed, short-lived, nonce-bound token mapped to a Business membership", async () => {
    const configuration = loadOidcConfiguration(environment());
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    jwk.use = "sig";
    jwk.alg = "RS256";
    const keyResolver = createLocalJWKSet({ keys: [jwk] });
    const now = Math.floor(Date.now() / 1_000);
    const nonce = Buffer.alloc(32, 2).toString("base64url");
    const token = await new SignJWT({ tid: tenantId, oid: principalId, nonce })
      .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" })
      .setIssuer(issuer)
      .setAudience(configuration.clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 3_600)
      .sign(privateKey);
    await expect(verifyOidcIdToken(configuration, token, nonce, keyResolver)).resolves.toMatchObject({
      userId: ids.user,
      organizationId: ids.organization,
      membershipId: ids.membership,
      externalTenantId: tenantId,
      externalPrincipalId: principalId,
      credentialHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await expect(verifyOidcIdToken(
      configuration,
      token,
      Buffer.alloc(32, 7).toString("base64url"),
      keyResolver,
    )).rejects.toThrow(/nonce_mismatch/);

    const ambiguousAudienceToken = await new SignJWT({ tid: tenantId, oid: principalId, nonce })
      .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" })
      .setIssuer(issuer)
      .setAudience([configuration.clientId, "another-client"])
      .setIssuedAt(now)
      .setExpirationTime(now + 3_600)
      .sign(privateKey);
    await expect(verifyOidcIdToken(
      configuration,
      ambiguousAudienceToken,
      nonce,
      keyResolver,
    )).rejects.toThrow(/token_rejected/);

    const unassignedConfiguration = Object.freeze({
      ...configuration,
      identityMap: new Map(),
    });
    const unassigned = await verifyOidcPrincipal(
      unassignedConfiguration,
      token,
      nonce,
      keyResolver,
    );
    expect(unassigned).toMatchObject({
      issuer,
      externalTenantId: tenantId,
      externalPrincipalId: principalId,
      mappedIdentity: null,
    });
    await expect(verifyOidcIdToken(
      unassignedConfiguration,
      token,
      nonce,
      keyResolver,
    )).rejects.toThrow(/identity_unassigned/);

    vi.stubEnv("IDENTITY_SECRET_FILE", "");
    vi.stubEnv("IDENTITY_SECRET", identitySecret);
    const proof = createOidcSignupProof(unassignedConfiguration, unassigned, Date.now());
    expect(consumeOidcSignupProof(proof, unassignedConfiguration)).toEqual({
      issuer,
      externalTenantId: tenantId,
      externalPrincipalId: principalId,
      credentialHash: unassigned.credentialHash,
    });
    expect(() => consumeOidcSignupProof(
      proof,
      unassignedConfiguration,
      Date.now() + 15 * 60 * 1_000 + 1,
    )).toThrow(/signup_proof_expired/);
  });
});
