import "server-only";

import { consumeRateLimit } from "@/modules/identity/auth-store";
import type { SessionPrincipal } from "@/modules/identity/session";
import { identityLookupHash } from "@/security/identity-secret";

export type BankingRateAction = "connect" | "sync" | "mapping" | "reconciliation" | "rule";

export async function consumeBankingRateLimit(
  principal: SessionPrincipal,
  action: BankingRateAction,
): Promise<Readonly<{ allowed: boolean; retryAfterSeconds: number }>> {
  const userLimits: Readonly<Record<BankingRateAction, readonly [number, number]>> = {
    connect: [5, 3600],
    sync: [12, 3600],
    mapping: [30, 60],
    reconciliation: [30, 60],
    rule: [30, 60],
  };
  const [userLimit, userWindowSeconds] = userLimits[action];
  const userKey = identityLookupHash(
    `banking-mutation|user|${principal.organizationId}|${principal.userId}|${action}`,
  );
  const decision = await consumeRateLimit(
    `banking-${action}-user`,
    userKey,
    userLimit,
    userWindowSeconds,
  );
  return {
    allowed: decision.allowed,
    retryAfterSeconds: decision.retry_after_seconds,
  };
}

export async function consumeBankingProviderOrganizationRateLimit(
  organizationId: string,
  action: "connect" | "sync",
): Promise<Readonly<{ allowed: boolean; retryAfterSeconds: number }>> {
  const aggregateLimits: Readonly<Record<"connect" | "sync", readonly [number, number]>> = {
    connect: [10, 3600],
    sync: [30, 3600],
  };
  const [limit, windowSeconds] = aggregateLimits[action];
  const key = identityLookupHash(
    `banking-mutation|organization|${organizationId}|${action}`,
  );
  const decision = await consumeRateLimit(
    `banking-${action}-organization`,
    key,
    limit,
    windowSeconds,
  );
  return {
    allowed: decision.allowed,
    retryAfterSeconds: decision.retry_after_seconds,
  };
}
