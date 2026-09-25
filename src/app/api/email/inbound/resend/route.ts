import { NextResponse } from "next/server";
import { observeRouteHandler } from "@/observability/request-observability";

// Explicitly retire the former receiving endpoint. Resend remains outbound-only.
async function retiredInboundEmail() {
  return NextResponse.json({ received: false }, {
    status: 410,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export const POST = observeRouteHandler("accounting-email-webhook", retiredInboundEmail);
