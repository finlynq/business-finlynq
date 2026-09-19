import { NextResponse } from "next/server";
import { ingestInboundEmail } from "@/modules/email/inbound";
import { ResendInboundProvider } from "@/modules/email/provider";
import { verifySvixWebhook, WebhookSignatureError } from "@/modules/email/signature";
import { emailResendApiKey, inboundWebhookSecret } from "@/modules/email/secrets";
import { observeRouteHandler } from "@/observability/request-observability";

const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

async function receiveInboundEmail(request: Request) {
  const secret = inboundWebhookSecret();
  const apiKey = emailResendApiKey();
  if (!secret || !apiKey) {
    return NextResponse.json({ received: false }, { status: 503, headers: { ...responseHeaders, "Retry-After": "30" } });
  }
  try {
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.length < 2 || bytes.length > 1024 * 1024) {
      return NextResponse.json({ received: false }, { status: 413, headers: responseHeaders });
    }
    const rawBody = bytes.toString("utf8");
    bytes.fill(0);
    verifySvixWebhook({
      rawBody,
      messageId: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
      secret,
    });
    const eventId = request.headers.get("svix-id")!;
    const message = await new ResendInboundProvider(apiKey).enrich(rawBody, eventId);
    const result = await ingestInboundEmail(message);
    return NextResponse.json({ received: true, retryPending: result.retryPending }, { status: 200, headers: responseHeaders });
  } catch (error) {
    if (error instanceof WebhookSignatureError) {
      return NextResponse.json({ received: false }, { status: 401, headers: responseHeaders });
    }
    const retryable = Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "EMAIL_PROVIDER_RETRYABLE");
    console.warn(JSON.stringify({ event: "email.inbound.failed", code: retryable ? "EMAIL_PROVIDER_RETRYABLE" : "EMAIL_INGEST_FAILED" }));
    return NextResponse.json({ received: false }, {
      status: retryable ? 503 : 500,
      headers: { ...responseHeaders, ...(retryable ? { "Retry-After": "5" } : {}) },
    });
  }
}

export const POST = observeRouteHandler("accounting-email-webhook", receiveInboundEmail);
