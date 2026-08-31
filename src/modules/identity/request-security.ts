import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import { identityLookupHash } from "@/security/identity-secret";

type RequestSecurityEnvironment = Readonly<Record<string, string | undefined>>;

const MAX_FORWARDED_FOR_BYTES = 1_024;
const MAX_FORWARDED_FOR_ADDRESSES = 16;

function trustedProxyHops(environment: RequestSecurityEnvironment): number | null {
  const raw = environment.TRUSTED_PROXY_HOPS?.trim();
  if (!raw || raw === "0") return null;
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const hops = Number(raw);
  return Number.isSafeInteger(hops) && hops <= MAX_FORWARDED_FOR_ADDRESSES ? hops : null;
}

function forwardedAddresses(value: string | null): string[] | null {
  if (!value || value.length > MAX_FORWARDED_FOR_BYTES) return null;
  const addresses = value.split(",").map((part) => part.trim());
  if (addresses.length === 0 || addresses.length > MAX_FORWARDED_FOR_ADDRESSES) return null;
  if (addresses.some((address) => !address || isIP(address) === 0)) return null;
  return addresses;
}

function allowsInsecureLoopbackTestOrigin(environment: RequestSecurityEnvironment, origin: URL): boolean {
  return environment.ALLOW_INSECURE_TEST_ORIGIN === "true" &&
    environment.BUSINESS_FINLYNQ_TEST_CONTEXT === "playwright" &&
    origin.protocol === "http:" &&
    (origin.hostname === "127.0.0.1" || origin.hostname === "localhost");
}

export function configuredAppOrigin(environment: RequestSecurityEnvironment = process.env): URL {
  const raw = environment.APP_ORIGIN?.trim() ?? (environment.NODE_ENV === "production" ? "" : "http://localhost:3000");
  if (!raw) throw new Error("APP_ORIGIN is required in production");
  const origin = new URL(raw);
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("APP_ORIGIN must contain only an origin");
  }
  if (environment.NODE_ENV === "production" && origin.protocol !== "https:" &&
      !allowsInsecureLoopbackTestOrigin(environment, origin)) {
    throw new Error("Production APP_ORIGIN must use HTTPS");
  }
  return origin;
}

export function validateSameOriginMutation(request: NextRequest): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;
  const expected = configuredAppOrigin().origin;
  const origin = request.headers.get("origin");
  if (origin) return origin === expected;
  const referer = request.headers.get("referer");
  if (!referer) return process.env.NODE_ENV !== "production";
  try { return new URL(referer).origin === expected; } catch { return false; }
}

export function clientIp(
  request: NextRequest,
  environment: RequestSecurityEnvironment = process.env,
): string {
  const trustedHops = trustedProxyHops(environment);
  if (trustedHops === null) return "unknown";

  const addresses = forwardedAddresses(request.headers.get("x-forwarded-for"));
  if (!addresses || addresses.length < trustedHops) return "unknown";
  return addresses[addresses.length - trustedHops] ?? "unknown";
}

export function userAgentFingerprint(userAgent: string | null): string {
  return identityLookupHash(`user-agent|${(userAgent ?? "").slice(0, 1000)}`);
}

export function requestFingerprints(request: NextRequest): { ipHash: string; userAgentHash: string } {
  return {
    ipHash: identityLookupHash(`ip|${clientIp(request)}`),
    userAgentHash: userAgentFingerprint(request.headers.get("user-agent")),
  };
}

export function isSpeculativeNavigation(request: NextRequest): boolean {
  const purpose = `${request.headers.get("purpose") ?? ""} ${request.headers.get("sec-purpose") ?? ""}`.toLowerCase();
  if (request.headers.get("next-router-prefetch") === "1" || purpose.includes("prefetch") || purpose.includes("prerender")) return true;
  const destination = request.headers.get("sec-fetch-dest");
  const mode = request.headers.get("sec-fetch-mode");
  return (destination !== null && destination !== "document") || (mode !== null && mode !== "navigate");
}
