import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notificationBrowserCookieName, notificationBrowserToken, prepareSigninNotification, trustedSigninGeo } from "@/modules/identity/signin-notification";
import { renderAuthenticationEmail } from "@/modules/identity/auth-email";

beforeEach(() => { vi.stubEnv("IDENTITY_SECRET", Buffer.alloc(64, 7).toString("base64")); vi.stubEnv("IDENTITY_SECRET_FILE", ""); });
afterEach(() => vi.unstubAllEnvs());

describe("sign-in notification browser and location policy", () => {
  it("recognizes a signed unexpired browser and replaces forged, cleared and expired cookies", () => {
    const now = Date.UTC(2026, 9, 15);
    const token = notificationBrowserToken(undefined, now);
    expect(notificationBrowserToken(token.value, now + 1000)).toEqual(token);
    for (const value of [undefined, "forged", token.value.replace(token.device, "A".repeat(43))]) {
      expect(notificationBrowserToken(value, now).device).not.toBe(token.device);
    }
    expect(notificationBrowserToken(token.value, now + 91 * 86400000).device).not.toBe(token.device);
  });
  it("scopes recognition to account and realm without granting MFA trust", () => {
    const token = notificationBrowserToken(undefined);
    const request = new NextRequest("https://app.example/api/auth/login", { headers: {
      cookie: `${notificationBrowserCookieName()}=${token.value}`, "user-agent": "Mozilla/5.0 Chrome/123 Linux",
    } });
    const one = prepareSigninNotification(request, { userId:"one",organizationId:"org" }, "password");
    expect(one.context.deviceHash).not.toBe(prepareSigninNotification(request,{userId:"two",organizationId:"org"},"password").context.deviceHash);
    expect(one.context.deviceHash).not.toBe(prepareSigninNotification(request,{userId:"one",organizationId:"other"},"password").context.deviceHash);
    expect(one.context.deviceHash).not.toBe(prepareSigninNotification(request,{userId:"one",organizationId:"org"},"oidc:realm").context.deviceHash);
    const response = NextResponse.json({});
    one.setCookie(response);
    expect(response.cookies.getAll().map(cookie => cookie.name)).toEqual([notificationBrowserCookieName()]);
    expect(response.cookies.get(notificationBrowserCookieName())).toMatchObject({ httpOnly:true, sameSite:"lax", path:"/" });
    expect(JSON.stringify(one.context)).not.toContain(token.device);
  });
  it("ignores untrusted headers and distinguishes unknown from low-confidence geography", () => {
    const headers = new Headers({ "x-finlynq-country":"CA","x-finlynq-region":"CA-ON","x-finlynq-geo-confidence":"high","x-finlynq-network-type":"residential" });
    expect(trustedSigninGeo(headers,{})).toEqual({ country:null,region:null,geoStatus:"UNAVAILABLE" });
    const enabled = {SIGNIN_TRUSTED_GEO_HEADERS:"true",TRUSTED_PROXY_HOPS:"1"};
    expect(trustedSigninGeo(headers,enabled)).toEqual({country:"CA",region:"CA-ON",geoStatus:"COARSE_REGION"});
    headers.set("x-finlynq-network-type","mobile");
    expect(trustedSigninGeo(headers,enabled)).toEqual({country:"CA",region:null,geoStatus:"COUNTRY_ONLY"});
    headers.set("x-finlynq-network-type","vpn");
    expect(trustedSigninGeo(headers,enabled).region).toBeNull();
    headers.set("x-finlynq-geo-confidence","low");
    expect(trustedSigninGeo(headers,enabled)).toEqual({country:null,region:null,geoStatus:"LOW_CONFIDENCE"});
    headers.set("x-finlynq-country","<script>");
    expect(trustedSigninGeo(headers,enabled).country).toBeNull();
  });
  it("renders one minimized context explanation and escapes browser labels", () => {
    const mail = renderAuthenticationEmail({templateType:"SECURITY_NEW_LOGIN",payload:{token:"must-not-render"},templateData:{
      reasons:["NEW_DEVICE","NEW_COUNTRY","NEW_LOCATION"],occurredAt:"2026-10-15T12:00:00Z",browserLabel:"Browser <script>",
      country:"CA",region:"CA-ON",geoStatus:"COARSE_REGION",sessionTokenHash:"must-not-render",
    }});
    expect(mail.text).toContain("new browser or device, new country, new approximate region");
    expect(mail.text).toContain("UTC");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).not.toContain("<script>");
    expect(JSON.stringify(mail)).not.toContain("must-not-render");
  });
});
