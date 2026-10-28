import "server-only";
import type { TenantTransactionContext } from "@/db/transaction";

// Only server-resolved aliases (verified ingress or durable retries) mint this
// capability. A caller-supplied authMethod, copied object or JSON cannot carry it.
const inboundWorkers = new WeakSet<TenantTransactionContext>();

export function inboundWorkerContext(input: Readonly<{
  organizationId: string; actorId: string; requestId: string;
  provider: "SELF_SMTP" | "RESEND";
}>): TenantTransactionContext {
  const context: TenantTransactionContext = Object.freeze({
    organizationId: input.organizationId,
    actorId: input.actorId,
    sessionMode: "real",
    requestId: input.requestId.slice(0, 200),
    authMethod: input.provider === "SELF_SMTP" ? "self-smtp-webhook" : "resend-webhook",
    sourceSurface: "WORKER",
    reason: "Verified inbound accounting email",
  });
  inboundWorkers.add(context);
  return context;
}

export function isInboundWorkerContext(context: TenantTransactionContext): boolean {
  return inboundWorkers.has(context);
}
