import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateRedirectUri, escapeHtml } from "@/modules/mcp/oauth-http";
import {
  oauthAuthorizationContentSecurityPolicy,
  oauthCallbackFormActionSource,
} from "@/modules/mcp/oauth-csp";
import {
  MCP_OAUTH_SCOPES,
  mintBoundToken,
  oauthPublicOrigin,
  parseBoundToken,
  parseRequestedScopes,
  verifyPkceS256,
} from "@/modules/mcp/protocol";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const oauthStoreSource = readFileSync("src/modules/mcp/oauth-store.ts", "utf8");

describe("remote MCP OAuth protocol", () => {
  it("mints opaque tokens bound to their kind, organization, and user", () => {
    const accessToken = mintBoundToken("at", organizationId, userId);
    expect(parseBoundToken(accessToken, "at")).toMatchObject({ kind: "at", organizationId, userId });
    expect(parseBoundToken(accessToken, "rt")).toBeNull();
    expect(accessToken).not.toContain("password");
  });

  it("accepts PKCE S256 and rejects malformed verifiers", () => {
    const verifier = "a".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256("short", challenge)).toBe(false);
  });

  it("enforces hierarchical write scopes and keeps offline access explicit", () => {
    expect(parseRequestedScopes(undefined)).toEqual([MCP_OAUTH_SCOPES.dailyRead]);
    expect(() => parseRequestedScopes(MCP_OAUTH_SCOPES.dailyWrite)).toThrow(/requires daily read/i);
    expect(parseRequestedScopes(`${MCP_OAUTH_SCOPES.dailyRead} ${MCP_OAUTH_SCOPES.dailyWrite} ${MCP_OAUTH_SCOPES.offlineAccess}`)).toHaveLength(3);
    expect(() => parseRequestedScopes("ledger:root")).toThrow(/not supported/i);
  });

  it("commits refresh-family revocation before surfacing token reuse", () => {
    const revoke = oauthStoreSource.indexOf("UPDATE mcp_refresh_tokens SET revoked_at");
    const commitSentinel = oauthStoreSource.indexOf("return { kind: \"reuse-detected\" as const }", revoke);
    const outerError = oauthStoreSource.indexOf("if (outcome.kind === \"reuse-detected\")", commitSentinel);
    expect(revoke).toBeGreaterThan(-1);
    expect(commitSentinel).toBeGreaterThan(revoke);
    expect(outerError).toBeGreaterThan(commitSentinel);
  });

  it("uses the existing application origin for deployment metadata", () => {
    const previousPublicOrigin = process.env.BUSINESS_FINLYNQ_PUBLIC_URL;
    const previousAppOrigin = process.env.APP_ORIGIN;
    try {
      delete process.env.BUSINESS_FINLYNQ_PUBLIC_URL;
      process.env.APP_ORIGIN = "https://dev.business.finlynq.example";
      expect(oauthPublicOrigin().origin).toBe("https://dev.business.finlynq.example");
    } finally {
      if (previousPublicOrigin === undefined) delete process.env.BUSINESS_FINLYNQ_PUBLIC_URL;
      else process.env.BUSINESS_FINLYNQ_PUBLIC_URL = previousPublicOrigin;
      if (previousAppOrigin === undefined) delete process.env.APP_ORIGIN;
      else process.env.APP_ORIGIN = previousAppOrigin;
    }
  });

  it("requires secure redirect URIs except for loopback development clients", () => {
    expect(validateRedirectUri("https://claude.example/callback")).toBe("https://claude.example/callback");
    expect(validateRedirectUri("http://127.0.0.1:8765/callback")).toBe("http://127.0.0.1:8765/callback");
    expect(() => validateRedirectUri("http://example.com/callback")).toThrow(/HTTPS/i);
    expect(() => validateRedirectUri("https://example.com/callback#fragment")).toThrow(/fragments/i);
  });

  it("escapes every HTML-significant consent-page character", () => {
    expect(escapeHtml(`<script a='b'>&\"`)).toBe("&lt;script a=&#39;b&#39;&gt;&amp;&quot;");
  });

  it("scopes OAuth consent form navigation to the registered callback origin", () => {
    expect(oauthCallbackFormActionSource("https://chatgpt.com/oauth/callback?secret=value"))
      .toBe("https://chatgpt.com");
    expect(oauthCallbackFormActionSource("http://127.0.0.1:8765/callback"))
      .toBe("http://127.0.0.1:8765");
    expect(oauthCallbackFormActionSource("http://example.com/callback")).toBeNull();
    expect(oauthAuthorizationContentSecurityPolicy("https://chatgpt.com/oauth/callback"))
      .toContain("form-action 'self' https://chatgpt.com");
  });
});
