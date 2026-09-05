import type { NextResponse } from "next/server";

export const TRUSTED_BROWSER_DURATIONS = [7, 30, 90] as const;
export type TrustedBrowserDurationDays = (typeof TRUSTED_BROWSER_DURATIONS)[number];

export function isTrustedBrowserDuration(value: number): value is TrustedBrowserDurationDays {
  return TRUSTED_BROWSER_DURATIONS.includes(value as TrustedBrowserDurationDays);
}

export function trustedBrowserCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? "__Host-business_finlynq_trusted_browser"
    : "business_finlynq_trusted_browser";
}

export function isPlausibleTrustedBrowserToken(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9_-]{43}$/.test(value));
}

export function setTrustedBrowserCookie(
  response: NextResponse,
  rawToken: string,
  expiresAt: Date,
  now = Date.now(),
): void {
  const maxAge = Math.max(1, Math.min(
    90 * 24 * 60 * 60,
    Math.ceil((expiresAt.getTime() - now) / 1000),
  ));
  response.cookies.set(trustedBrowserCookieName(), rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
    maxAge,
    priority: "high",
  });
}

export function clearTrustedBrowserCookie(response: NextResponse): void {
  response.cookies.set(trustedBrowserCookieName(), "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    priority: "high",
  });
}

function browserName(userAgent: string): string {
  if (/Edg\//i.test(userAgent)) return "Microsoft Edge";
  if (/OPR\//i.test(userAgent)) return "Opera";
  if (/Firefox\//i.test(userAgent)) return "Firefox";
  if (/CriOS\//i.test(userAgent)) return "Chrome";
  if (/Chrome\//i.test(userAgent)) return "Chrome";
  if (/FxiOS\//i.test(userAgent)) return "Firefox";
  if (/Safari\//i.test(userAgent)) return "Safari";
  return "Browser";
}

function platformName(userAgent: string): string {
  if (/Android/i.test(userAgent)) return "Android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "iOS";
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macOS";
  if (/CrOS/i.test(userAgent)) return "ChromeOS";
  if (/Linux/i.test(userAgent)) return "Linux";
  return "unknown device";
}

/**
 * This label is display-only. Authentication uses the opaque cookie, the
 * server-side token digest, tenant/user membership, security epoch, and the
 * separately derived User-Agent hash.
 */
export function trustedBrowserLabel(userAgent: string | null): string {
  const bounded = (userAgent ?? "").slice(0, 1_000);
  return `${browserName(bounded)} on ${platformName(bounded)}`.slice(0, 160);
}
