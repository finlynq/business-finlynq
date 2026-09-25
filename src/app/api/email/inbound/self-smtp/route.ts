import { NextResponse } from "next/server";
import { ingestInboundEmail } from "@/modules/email/inbound";
import type { InboundProviderMessage } from "@/modules/email/model";
import { inboundRelaySecret } from "@/modules/email/secrets";
import { inboundEmailRouting, matchesInboundEmailRouting } from "@/modules/email/routing";
import { parseRelayMessage, readRelayBody, RelayPayloadError } from "@/modules/email/self-smtp";
import { verifyRelayWebhook, WebhookSignatureError } from "@/modules/email/signature";
import { observeRouteHandler } from "@/observability/request-observability";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

async function receiveInboundEmail(request: Request) {
  let bytes: Buffer | undefined;
  let message: InboundProviderMessage | undefined;
  try {
    const secret = inboundRelaySecret();
    const routing = inboundEmailRouting();
    if (!secret || !routing) {
      return NextResponse.json({ received: false }, { status: 503, headers: { ...headers, "Retry-After": "30" } });
    }
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ received: false }, { status: 415, headers });
    }
    bytes = await readRelayBody(request);
    verifyRelayWebhook({ rawBody: bytes, secret,
      timestamp: request.headers.get("x-mail-timestamp"), signature: request.headers.get("x-mail-signature") });
    message = parseRelayMessage(bytes);
    const messageId = request.headers.get("x-mail-message-id");
    if (messageId !== null && messageId !== message.messageId) throw new RelayPayloadError();
    if (!matchesInboundEmailRouting(message.to[0], routing)) throw new RelayPayloadError();
    const result = await ingestInboundEmail(message);
    // 2xx lets the relay delete its copy. Ingestion has already durably stored
    // the content, or intentionally ignored an inactive/unrecognized alias.
    return NextResponse.json({ received: true, retryPending: result.retryPending }, { headers });
  } catch (error) {
    const status = error instanceof WebhookSignatureError ? 401 : error instanceof RelayPayloadError ? error.status : 503;
    if (status === 503) console.warn(JSON.stringify({ event: "email.inbound.failed", code: "EMAIL_INGEST_FAILED" }));
    return NextResponse.json({ received: false }, {
      status, headers: { ...headers, ...(status === 503 ? { "Retry-After": "30" } : {}) },
    });
  } finally {
    bytes?.fill(0);
    for (const attachment of message?.attachments ?? []) attachment.content?.fill(0);
  }
}

export const POST = observeRouteHandler("accounting-email-webhook", receiveInboundEmail);
