import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { identityLookupHash } from "@/security/identity-secret";
import { trustedBrowserLabel } from "./trusted-browser";

const lifetimeSeconds = 90 * 24 * 60 * 60;
type Environment = Readonly<Record<string, string | undefined>>;
export type SigninNotificationContext = Readonly<{
  deviceHash: string;
  realm: string;
  browserLabel: string;
  country: string | null;
  region: string | null;
  geoStatus: "UNAVAILABLE" | "LOW_CONFIDENCE" | "COUNTRY_ONLY" | "COARSE_REGION";
}>;

export function notificationBrowserCookieName(environment: Environment = process.env): string {
  return environment.NODE_ENV === "production" ? "__Host-business_finlynq_notification_browser" : "business_finlynq_notification_browser";
}

/** This cookie recognizes notification context only. It never authenticates a session or bypasses MFA. */
export function notificationBrowserToken(raw: string | undefined, now = Date.now()): { value: string; device: string; expires: number } {
  const parts = raw?.split(".");
  if (parts?.length === 4 && parts[0] === "v1" && /^[A-Za-z0-9_-]{43}$/.test(parts[1]!)
    && /^\d{10}$/.test(parts[2]!) && /^[a-f0-9]{64}$/.test(parts[3]!)) {
    const expires = Number(parts[2]);
    const signature = identityLookupHash(`notification-browser|${parts.slice(0, 3).join(".")}`);
    if (expires > Math.floor(now / 1000) && expires <= Math.floor(now / 1000) + lifetimeSeconds
      && timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(parts[3]!, "hex"))) {
      return { value: raw!, device: parts[1]!, expires };
    }
  }
  const device = randomBytes(32).toString("base64url");
  const expires = Math.floor(now / 1000) + lifetimeSeconds;
  const payload = `v1.${device}.${expires}`;
  return { value: `${payload}.${identityLookupHash(`notification-browser|${payload}`)}`, device, expires };
}

export function trustedSigninGeo(headers: Headers, environment: Environment = process.env): Pick<SigninNotificationContext, "country" | "region" | "geoStatus"> {
  // Opt-in requires an edge that strips/replaces all four headers. Current
  // deployments leave this off: ordinary client-supplied geo is never trusted.
  if (environment.SIGNIN_TRUSTED_GEO_HEADERS !== "true" || !/^(?:[1-9]|1[0-6])$/.test(environment.TRUSTED_PROXY_HOPS ?? "")) {
    return { country: null, region: null, geoStatus: "UNAVAILABLE" };
  }
  if (headers.get("x-finlynq-geo-confidence") !== "high") {
    return { country: null, region: null, geoStatus: "LOW_CONFIDENCE" };
  }
  const country = headers.get("x-finlynq-country");
  if (!country || !/^[A-Z]{2}$/.test(country) || ["XX", "ZZ"].includes(country)) {
    return { country: null, region: null, geoStatus: "UNAVAILABLE" };
  }
  const region = headers.get("x-finlynq-region");
  const network = headers.get("x-finlynq-network-type");
  if (network !== "residential" || !region || !new RegExp(`^${country}-[A-Z0-9]{1,3}$`).test(region)) {
    return { country, region: null, geoStatus: "COUNTRY_ONLY" };
  }
  return { country, region, geoStatus: "COARSE_REGION" };
}

export function prepareSigninNotification(request: NextRequest, identity: { userId: string; organizationId: string }, realm: string) {
  const browser = notificationBrowserToken(request.cookies.get(notificationBrowserCookieName())?.value);
  const context: SigninNotificationContext = {
    deviceHash: identityLookupHash(`notification-device|${identity.organizationId}|${identity.userId}|${realm}|${browser.device}`),
    realm,
    browserLabel: trustedBrowserLabel(request.headers.get("user-agent")),
    ...trustedSigninGeo(request.headers),
  };
  return { context, setCookie(response: NextResponse) {
    response.cookies.set(notificationBrowserCookieName(), browser.value, {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/",
      expires: new Date(browser.expires * 1000), maxAge: Math.max(1, browser.expires - Math.floor(Date.now() / 1000)),
    });
  } };
}
