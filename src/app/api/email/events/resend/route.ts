import { NextResponse } from "next/server";
import { recordOutboundDeliveryEvent } from "@/modules/email/outbound";
import { verifySvixWebhook, WebhookSignatureError } from "@/modules/email/signature";
import { outboundWebhookSecret } from "@/modules/email/secrets";
import { observeRouteHandler } from "@/observability/request-observability";

const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

async function receiveDeliveryEvent(request: Request) {
  const secret = outboundWebhookSecret();
  if (!secret) return NextResponse.json({ received: false }, { status: 503, headers: responseHeaders });
  try {
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.length < 2 || bytes.length > 256 * 1024) return NextResponse.json({ received: false }, { status: 413, headers: responseHeaders });
    const rawBody = bytes.toString("utf8");
    bytes.fill(0);
    const eventId = request.headers.get("svix-id");
    verifySvixWebhook({
      rawBody,
      messageId: eventId,
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
      secret,
    });
    await recordOutboundDeliveryEvent(eventId!, JSON.parse(rawBody));
    return NextResponse.json({ received: true }, { status: 200, headers: responseHeaders });
  } catch (error) {
    if (error instanceof WebhookSignatureError) return NextResponse.json({ received: false }, { status: 401, headers: responseHeaders });
    console.warn(JSON.stringify({ event: "email.delivery-callback.failed", code: "EMAIL_CALLBACK_FAILED" }));
    return NextResponse.json({ received: false }, { status: 500, headers: responseHeaders });
  }
}

export const POST = observeRouteHandler("accounting-email-webhook", receiveDeliveryEvent);
