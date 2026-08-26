import type { NextRequest } from "next/server";
import { identityLookupHash } from "@/security/identity-secret";

export function configuredAppOrigin(): URL {
  const raw = process.env.APP_ORIGIN?.trim() ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
  if (!raw) throw new Error("APP_ORIGIN is required in production");
  const origin = new URL(raw);
  if (origin.pathname !== "/" || origin.search || origin.hash) throw new Error("APP_ORIGIN must contain only an origin");
  if (process.env.NODE_ENV === "production" && origin.protocol !== "https:") throw new Error("Production APP_ORIGIN must use HTTPS");
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

export function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() || "unknown";
}

export function requestFingerprints(request: NextRequest): { ipHash: string; userAgentHash: string | null } {
  const userAgent = request.headers.get("user-agent")?.slice(0, 1000) ?? null;
  return {
    ipHash: identityLookupHash(`ip|${clientIp(request)}`),
    userAgentHash: userAgent ? identityLookupHash(`user-agent|${userAgent}`) : null,
  };
}

export function isSpeculativeNavigation(request: NextRequest): boolean {
  const purpose = `${request.headers.get("purpose") ?? ""} ${request.headers.get("sec-purpose") ?? ""}`.toLowerCase();
  if (request.headers.get("next-router-prefetch") === "1" || purpose.includes("prefetch") || purpose.includes("prerender")) return true;
  const destination = request.headers.get("sec-fetch-dest");
  const mode = request.headers.get("sec-fetch-mode");
  return (destination !== null && destination !== "document") || (mode !== null && mode !== "navigate");
}
