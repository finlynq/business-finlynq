import "server-only";

const PREFIX_BY_ORIGIN = {
  "https://dev.business.finlynq.com": "businessdev-",
  "https://stage.business.finlynq.com": "businessstage-",
  "https://business.finlynq.com": "business-",
} as const;

export type InboundEmailRouting = Readonly<{ domain: string; prefix: string }>;

export function inboundEmailRouting(): InboundEmailRouting | null {
  const domain = process.env.BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN?.trim().toLowerCase();
  const prefix = process.env.BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX?.trim();
  if (!domain || domain.length > 253
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)
      || !prefix || !Object.values(PREFIX_BY_ORIGIN).some((value) => value === prefix)) return null;
  const appOrigin = process.env.APP_ORIGIN?.trim();
  if (appOrigin) {
    let origin: string;
    try { origin = new URL(appOrigin).origin; } catch { return null; }
    const expected = PREFIX_BY_ORIGIN[origin as keyof typeof PREFIX_BY_ORIGIN];
    if (expected && prefix !== expected) return null;
  }
  return { domain, prefix };
}

export function matchesInboundEmailRouting(address: string, routing: InboundEmailRouting): boolean {
  const [local, domain, extra] = address.trim().toLowerCase().split("@");
  return extra === undefined && domain === routing.domain && local.startsWith(routing.prefix)
    && /^[0-9a-f]{32}$/.test(local.slice(routing.prefix.length));
}
