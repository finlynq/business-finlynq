import "server-only";

import { randomUUID } from "node:crypto";
import type { McpServer, ServerEvent, ServerEventBus } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { isAuthorizationDeniedError } from "@/modules/identity/authorization-error";
import { INVOICE_NOTIFICATION_REFRESH_MS, INVOICE_NOTIFICATION_RESOURCE,
  readInvoiceNotifications, unavailableInvoiceNotifications } from "@/modules/email/invoice-notifications";
import { isMcpToolVisible, loadMcpAuthorizationSnapshot, type McpAuthorizationSnapshot } from "./connection-policy";
import { mcpMutationContext, type McpConnectionPrincipal } from "./oauth-store";
import { defineMcpTool } from "./tool-types";

export const INVOICE_NOTIFICATION_POLICY = {
  name: "finlynq_daily_get_invoice_notifications", group: "DAILY", access: "READ", permission: PERMISSIONS.readPayables,
} as const;
export const invoiceNotificationDelivery = {
  resourceUri: INVOICE_NOTIFICATION_RESOURCE,
  subscription: { protocolVersion: "2026-07-28", method: "subscriptions/listen", notifications: { resourceSubscriptions: [INVOICE_NOTIFICATION_RESOURCE] } },
  refreshAfterMs: INVOICE_NOTIFICATION_REFRESH_MS,
  fallback: "If the client cannot consume resource subscriptions, poll finlynq_daily_get_invoice_notifications every 15 seconds while active, passing the last revision. Hosts must run the subscription or polling loop; a passive chat cannot wake itself. Unchanged revisions need no repeated prompt.",
};

export async function invoiceNotificationsForSnapshot(snapshot: McpAuthorizationSnapshot, afterRevision?: string) {
  if (!isMcpToolVisible(snapshot, INVOICE_NOTIFICATION_POLICY)) return { availability: "NOT_AUTHORIZED" as const, shouldNotify: false };
  try { return await readInvoiceNotifications(mcpMutationContext(snapshot.principal, randomUUID()), afterRevision); }
  catch (error) {
    if (isAuthorizationDeniedError(error)) throw error;
    return unavailableInvoiceNotifications();
  }
}

export const INVOICE_NOTIFICATION_MCP_TOOLS = [defineMcpTool({
  policy: INVOICE_NOTIFICATION_POLICY, title: "Check received invoice notifications",
  description: "Read pending emailed invoices without claiming, creating or posting anything. Shows ready, review, claimed, intake-pending and failed work; supporting receipts, duplicates and completed drafts are excluded. Present shouldNotify reminders once per revision and offer the existing invoice workflow. For live sessions subscribe to finlynq://inbox/payables/email using supported MCP resource subscriptions, or have the host poll every 15 seconds with afterRevision. UNAVAILABLE means unknown, never zero.",
  inputSchema: z.object({ afterRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  invoke: async (args, runtime) => ({ ...await invoiceNotificationsForSnapshot(runtime.snapshot, args.afterRevision), delivery: invoiceNotificationDelivery }),
})];

export function registerInvoiceNotificationResource(server: McpServer, snapshot: McpAuthorizationSnapshot) {
  if (!isMcpToolVisible(snapshot, INVOICE_NOTIFICATION_POLICY)) return;
  server.registerResource("pending-emailed-invoices", INVOICE_NOTIFICATION_RESOURCE, {
    title: "Received invoices awaiting processing", mimeType: "application/json",
    description: "Read-only pending email invoice summary. Subscribe for active-session changes; reread after each update and deduplicate by revision. Receiving a notice does not process an invoice.",
    cacheHint: { ttlMs: 0, cacheScope: "private" },
  }, async (uri) => {
    const fresh = await loadMcpAuthorizationSnapshot(snapshot.principal);
    if (!isMcpToolVisible(fresh, INVOICE_NOTIFICATION_POLICY)) throw new Error("Invoice notification permission is no longer available");
    const summary = await invoiceNotificationsForSnapshot(fresh);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ ...summary, delivery: invoiceNotificationDelivery }) }] };
  });
}

type LiveSummary = Awaited<ReturnType<typeof readInvoiceNotifications>> | ReturnType<typeof unavailableInvoiceNotifications>;
/** One bus per authenticated request: no organization or connection shares listeners.
 * Polling durable state also observes invoices ingested by a separate worker/process.
 */
export class InvoiceNotificationBus implements ServerEventBus {
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private revision: string | undefined;
  private polling = false;
  private stopped = false;
  constructor(private readonly load: () => Promise<LiveSummary>, private readonly onDenied: () => void,
    private readonly intervalMs = INVOICE_NOTIFICATION_REFRESH_MS) {}
  publish(event: ServerEvent) { for (const listener of this.listeners) listener(event); }
  subscribe(listener: (event: ServerEvent) => void) {
    if (this.stopped) return () => {};
    this.listeners.add(listener);
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), this.intervalMs);
      this.timer.unref?.();
      void this.poll();
    }
    return () => { this.listeners.delete(listener); if (!this.listeners.size) this.close(); };
  }
  private async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const summary = await this.load();
      if (this.stopped) return;
      const changed = summary.revision !== this.revision;
      const initial = this.revision === undefined;
      this.revision = summary.revision;
      if (changed && (!initial || summary.shouldNotify || summary.availability === "UNAVAILABLE")) {
        this.publish({ kind: "resource_updated", uri: INVOICE_NOTIFICATION_RESOURCE,
          params: { "finlynq/revision": summary.revision } });
      }
    } catch { this.close(); this.onDenied(); }
    finally { this.polling = false; }
  }
  close() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.listeners.clear(); }
}

export async function loadLiveInvoiceSummary(principal: McpConnectionPrincipal) {
  const snapshot = await loadMcpAuthorizationSnapshot(principal);
  if (!isMcpToolVisible(snapshot, INVOICE_NOTIFICATION_POLICY)) throw new Error("Invoice notification access revoked");
  const summary = await invoiceNotificationsForSnapshot(snapshot);
  if (!("revision" in summary)) throw new Error("Invoice notification access revoked");
  return summary;
}
