import "server-only";

import { consumeRateLimit } from "@/modules/identity/auth-store";
import type { SessionPrincipal } from "@/modules/identity/session";
import { identityLookupHash } from "@/security/identity-secret";

export async function consumeLedgerMutationRateLimit(
  principal: SessionPrincipal,
  action: "create" | "post" | "reverse" | "unpost" | "delete" | "period" | "party",
): Promise<Readonly<{ allowed: boolean; retryAfterSeconds: number }>> {
  // Public demo users come from a reusable sandbox pool. Their user IDs are
  // therefore infrastructure identities, not individual actors; sharing the
  // daily bucket across leased sessions lets one visitor throttle the next.
  // Real-account buckets remain user-based so a new login cannot evade them.
  const dailyActorIdentity = principal.sessionMode === "demo"
    ? `demo-session:${principal.sessionId}`
    : principal.userId;
  const sessionKey = identityLookupHash(
    `ledger-mutation-session|${principal.organizationId}|${principal.sessionId}|${action}`,
  );
  const actorKey = identityLookupHash(
    `ledger-mutation-actor|${principal.organizationId}|${dailyActorIdentity}|${action}`,
  );
  const perMinuteLimit = action === "create" ? 30 : action === "period" ? 10 : 20;
  const perDayLimit = action === "reverse" || action === "unpost" || action === "delete"
    ? 100
    : action === "period" ? 50 : action === "party" ? 200 : 300;
  const [perSession, perActor] = await Promise.all([
    consumeRateLimit(`ledger-${action}-session-minute`, sessionKey, perMinuteLimit, 60),
    consumeRateLimit(`ledger-${action}-actor-day`, actorKey, perDayLimit, 86_400),
  ]);
  const denied = [perSession, perActor].filter((result) => !result.allowed);
  return {
    allowed: denied.length === 0,
    retryAfterSeconds: denied.length === 0
      ? 0
      : Math.max(...denied.map((result) => result.retry_after_seconds)),
  };
}
