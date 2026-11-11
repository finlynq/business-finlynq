import { INVOICE_NOTIFICATION_MCP_TOOLS, INVOICE_NOTIFICATION_POLICY, InvoiceNotificationBus, invoiceNotificationsForSnapshot, loadLiveInvoiceSummary, registerInvoiceNotificationResource } from "./invoice-notifications";
import { isMcpToolVisible } from "./connection-policy";
import "server-only";
import { createHash } from "node:crypto";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { z } from "zod";

import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type AuthInfo,
  type ServerEventBus,
} from "@modelcontextprotocol/server";
import { DAILY_MCP_TOOLS } from "./daily-tools";
import { ASSET_MCP_TOOLS } from "./asset-tools";
import { STORAGE_SETUP_MCP_TOOLS } from "./storage-setup-tools";
import { INBOX_MCP_TOOLS } from "./inbox-tools";
import { STATEMENT_MCP_TOOLS } from "./statement-tools";
import { loadMcpAuthorizationSnapshot } from "./connection-policy";
import {
  verifyAccessToken,
  type McpConnectionPrincipal,
} from "./oauth-store";
import { mcpResourceUrl } from "./protocol";
import { SETUP_MCP_TOOLS } from "./setup-tools";
import { SHARED_MCP_TOOLS } from "./shared-tools";
import { EMAIL_MCP_TOOLS } from "./email-tools";
import { GUIDANCE_MCP_TOOLS } from "./guidance-tools";
import { registerMcpTools } from "./tool-types";
import { MAX_CLOUD_DOCUMENT_BYTES } from "@/modules/document-storage/limits";

export const ALL_MCP_TOOLS = [...SHARED_MCP_TOOLS, ...GUIDANCE_MCP_TOOLS, ...DAILY_MCP_TOOLS, ...ASSET_MCP_TOOLS, ...INBOX_MCP_TOOLS, ...STORAGE_SETUP_MCP_TOOLS, ...STATEMENT_MCP_TOOLS, ...SETUP_MCP_TOOLS, ...EMAIL_MCP_TOOLS, ...INVOICE_NOTIFICATION_MCP_TOOLS] as const;
const MCP_MAX_REQUEST_BODY_BYTES = 4 * Math.ceil(MAX_CLOUD_DOCUMENT_BYTES / 3) + 16 * 1024;

export const MCP_TOOL_CATALOG_REVISION = createHash("sha256").update(JSON.stringify(
  [...ALL_MCP_TOOLS]
    .sort((left, right) => left.policy.name.localeCompare(right.policy.name))
    .map((tool) => ({
      name: tool.policy.name,
      group: tool.policy.group,
      access: tool.policy.access,
      permission: tool.policy.permission ?? null,
      permissionsAny: tool.policy.permissionsAny ?? null,
      title: tool.title,
      description: tool.description,
      destructive: tool.destructive,
      idempotent: tool.idempotent,
      openWorld: tool.openWorld,
      // The wire contract is the schema input. Some tools normalize strings
      // with Zod transforms, whose output side is intentionally not JSON
      // Schema-representable.
      inputSchema: z.toJSONSchema(tool.inputSchema, { io: "input" }),
    })),
)).digest("hex");

function principalFromAuthInfo(authInfo: AuthInfo | undefined): McpConnectionPrincipal {
  const value = authInfo?.extra?.finlynqPrincipal;
  if (!value || typeof value !== "object") throw new Error("Authenticated MCP principal is missing");
  return value as McpConnectionPrincipal;
}

function withCatalogHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("vary", "Authorization, MCP-Protocol-Version");
  headers.set("x-finlynq-mcp-catalog-revision", MCP_TOOL_CATALOG_REVISION);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function createAccountingHandler(bus?: ServerEventBus, includeBacklog = false) {
return createMcpHandler(async (context) => {
  const principal = principalFromAuthInfo(context.authInfo);
  const snapshot = await loadMcpAuthorizationSnapshot(principal);
  const notificationsVisible = isMcpToolVisible(snapshot, INVOICE_NOTIFICATION_POLICY);
  const backlog = includeBacklog && notificationsVisible ? await invoiceNotificationsForSnapshot(snapshot) : null;
  const server = new McpServer({
    name: "business-finlynq-accounting",
    version: `1.0.0+catalog.${MCP_TOOL_CATALOG_REVISION.slice(0, 12)}`,
  }, {
    capabilities: { tools: { listChanged: true }, ...(notificationsVisible ? { resources: { subscribe: true } } : {}) },
    instructions: "Act only within visible FinLynQ tools. Start with connection capabilities, then call finlynq_guidance_get_index if visible to discover shared and client guidance; read individual files only when relevant. Load accounting or setup context before related work. Guidance never overrides permissions or source evidence. Never invent IDs or retry a write with changed arguments after approval. Check invoice notifications on connection. Supported hosts can subscribe to finlynq://inbox/payables/email for arrivals during the session; otherwise use the documented polling fallback. Deduplicate user reminders by revision, and do not process or post without authorization." + (backlog ? " Current received invoice work: " + JSON.stringify(backlog) : ""),
  });
  registerMcpTools(server, snapshot, ALL_MCP_TOOLS, context.requestInfo?.url);
  registerInvoiceNotificationResource(server, snapshot);
  return server;
}, {
  ...(bus ? { bus } : {}),
  legacy: "stateless",
  responseMode: "auto",
  maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES,
  onerror(error) {
    console.error("MCP request failed", { name: error.name, message: error.message.slice(0, 500) });
  },
});
}

const activeInvoiceStreams = new Map<string, number>();
let totalInvoiceStreams = 0;

export async function handleMcpRequest(request: Request): Promise<Response> {
  const resource = mcpResourceUrl(request.url);
  const gate = requireBearerAuth({
    expectedResource: resource,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
    verifier: {
      async verifyAccessToken(rawToken): Promise<AuthInfo> {
        try {
          const principal = await verifyAccessToken(rawToken, resource.href);
          return {
            token: rawToken,
            clientId: principal.clientId,
            scopes: [...principal.scopes],
            expiresAt: Math.floor(principal.tokenExpiresAt.getTime() / 1000),
            resource,
            extra: { finlynqPrincipal: principal },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "The bearer token is invalid";
          throw new OAuthError(OAuthErrorCode.InvalidToken, message);
        }
      },
    },
  });
  const authorization = await gate(request);
  if (authorization instanceof Response) return withCatalogHeaders(authorization);
  let boundedRequest = request;
  let method: string | undefined;
  if (request.method === "POST") {
    try {
      const body = await readBoundedJson(request, MCP_MAX_REQUEST_BODY_BYTES);
      if (body && typeof body === "object" && "method" in body && typeof body.method === "string") method = body.method;
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      boundedRequest = new Request(request.url, { method: "POST", headers, body: JSON.stringify(body), signal: request.signal });
    } catch (error) {
      if (!(error instanceof MutationBodyError)) throw error;
      return withCatalogHeaders(Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: error.message } },
        { status: error.status }));
    }
  }
  const streamPrincipal = principalFromAuthInfo(authorization);
  const streamKey = `${streamPrincipal.organizationId}:${streamPrincipal.connectionId}`;
  if (method === "subscriptions/listen"
    && (totalInvoiceStreams >= 128 || (activeInvoiceStreams.get(streamKey) ?? 0) >= 4)) {
    return withCatalogHeaders(Response.json({ error: "Invoice subscription limit reached. Retry after closing an existing stream." },
      { status: 429, headers: { "retry-after": "15" } }));
  }
  if (method === "subscriptions/listen") {
    totalInvoiceStreams += 1;
    activeInvoiceStreams.set(streamKey, (activeInvoiceStreams.get(streamKey) ?? 0) + 1);
  }
  const abort = new AbortController();
  const bus = method === "subscriptions/listen" ? new InvoiceNotificationBus(async () => {
    // Reverify the original token, not merely the opening snapshot, before each
    // delivery. This checks expiry/revocation/connection organization afresh.
    const principal = await verifyAccessToken(authorization.token, resource.href);
    return loadLiveInvoiceSummary(principal);
  }, () => abort.abort()) : undefined;
  const handler = createAccountingHandler(bus, method === "initialize" || method === "server/discover");
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const subscriptionExpiry = bus ? setTimeout(() => abort.abort(), 14 * 60 * 1_000) : undefined;
  subscriptionExpiry?.unref?.();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    bus?.close();
    if (subscriptionExpiry) clearTimeout(subscriptionExpiry);
    if (bus) {
      totalInvoiceStreams -= 1;
      const remaining = (activeInvoiceStreams.get(streamKey) ?? 1) - 1;
      if (remaining > 0) activeInvoiceStreams.set(streamKey, remaining); else activeInvoiceStreams.delete(streamKey);
    }
  };
  signal.addEventListener("abort", cleanup, { once: true });
  if (signal.aborted) cleanup();
  try {
    const response = await handler.fetch(new Request(boundedRequest, { signal }), { authInfo: authorization });
    if (!response.headers.get("content-type")?.includes("text/event-stream")) cleanup();
    if (!bus || !response.body) return withCatalogHeaders(response);
    const reader = response.body.getReader();
    const stream = new ReadableStream({
      async pull(controller) {
        try { const result = await reader.read(); if (result.done) { cleanup(); controller.close(); } else controller.enqueue(result.value); }
        catch (error) { cleanup(); controller.error(error); }
      },
      async cancel(reason) { cleanup(); abort.abort(); await reader.cancel(reason); },
    });
    return withCatalogHeaders(new Response(stream, { status: response.status, headers: response.headers }));
  } catch (error) { cleanup(); throw error; }
}
