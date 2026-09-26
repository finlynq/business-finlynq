import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inboundEmailRouting, matchesInboundEmailRouting } from "@/modules/email/routing";

beforeEach(() => {
  vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN", "mail.finlynq.com");
  vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX", "businessdev-");
  vi.stubEnv("APP_ORIGIN", "https://dev.business.finlynq.com");
});
afterEach(() => vi.unstubAllEnvs());

describe("shared receiving domain", () => {
  it.each([
    ["https://dev.business.finlynq.com", "businessdev-"],
    ["https://stage.business.finlynq.com", "businessstage-"],
    ["https://business.finlynq.com", "business-"],
  ])("isolates %s by its fixed namespace", (origin, prefix) => {
    vi.stubEnv("APP_ORIGIN", `${origin}/`);
    vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX", prefix);
    const routing = inboundEmailRouting()!;
    expect(routing).toEqual({ domain: "mail.finlynq.com", prefix });
    expect(matchesInboundEmailRouting(`${prefix}${"A".repeat(32)}@MAIL.FINLYNQ.COM`, routing)).toBe(true);
    for (const other of ["businessdev-", "businessstage-", "business-", "import-", "importdev-", "in+"]) {
      if (other !== prefix) expect(matchesInboundEmailRouting(`${other}${"a".repeat(32)}@mail.finlynq.com`, routing)).toBe(false);
    }
    for (const token of ["a".repeat(31), "a".repeat(33), "g".repeat(32), "a".repeat(32) + "+tag"]) {
      expect(matchesInboundEmailRouting(`${prefix}${token}@mail.finlynq.com`, routing)).toBe(false);
    }
    expect(matchesInboundEmailRouting(`${prefix}${"a".repeat(32)}@other.example`, routing)).toBe(false);
    expect(matchesInboundEmailRouting(`${prefix}${"a".repeat(32)}@mail.finlynq.com@other.example`, routing)).toBe(false);
  });

  it("fails closed on missing/invalid domain, namespace and environment mismatch", () => {
    for (const domain of ["", "localhost", "x@mail.finlynq.com", "https://mail.finlynq.com", "bad..example"]) {
      vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN", domain);
      expect(inboundEmailRouting()).toBeNull();
    }
    vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN", " MAIL.FINLYNQ.COM ");
    expect(inboundEmailRouting()?.domain).toBe("mail.finlynq.com");
    for (const prefix of ["", "business-", "businessstage-", "import-", "businessdev-.*", "BUSINESSDEV-"]) {
      vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX", prefix);
      expect(inboundEmailRouting()).toBeNull();
    }
    vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX", "businessdev-");
    vi.stubEnv("APP_ORIGIN", "malformed");
    expect(inboundEmailRouting()).toBeNull();
  });
});
