import "server-only";
import type { TenantTransactionContext } from "@/db/transaction";
const workers = new WeakMap<TenantTransactionContext, string>();
export function documentFilingWorkerContext(input: { organizationId: string; actorId: string; itemId: string; requestId: string }): TenantTransactionContext {
  const context: TenantTransactionContext = Object.freeze({ organizationId: input.organizationId, actorId: input.actorId,
    sessionMode: "real", requestId: input.requestId, authMethod: "document-filing-worker", sourceSurface: "WORKER", reason: "Recover durable completed-document filing" });
  workers.set(context, input.itemId);
  return context;
}
export function isDocumentFilingWorkerContext(context: TenantTransactionContext) { return workers.has(context); }
export function assertFilingWorkerScope(context: TenantTransactionContext, itemId: string) {
  if (workers.has(context) && workers.get(context) !== itemId) throw new Error("Filing worker scope does not match its saved item");
}
