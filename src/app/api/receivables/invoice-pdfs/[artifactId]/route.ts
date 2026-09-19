import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import { requestPrincipal } from "@/modules/identity/session";
import { mutationContext } from "@/modules/workspace/write-policy";
import { downloadInvoicePdf } from "@/modules/email/outbound";

const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
  "X-Robots-Tag": "noindex",
};

async function download(request: NextRequest, routeContext: { params: Promise<{ artifactId: string }> }) {
  try {
    const principal = await requestPrincipal(request);
    if (!principal) return NextResponse.json({ error: "Authentication required." }, { status: 401, headers });
    const parsed = z.uuid().safeParse((await routeContext.params).artifactId);
    if (!parsed.success) return NextResponse.json({ error: "Invoice PDF not found." }, { status: 404, headers });
    const result = await downloadInvoicePdf(
      mutationContext(principal, requestIdFor(request), { reason: "Download invoice PDF", sourceSurface: "API" }),
      parsed.data,
    );
    const body = new Uint8Array(result.bytes);
    result.bytes.fill(0);
    return new NextResponse(body, { headers: {
      ...headers,
      "Content-Type": "application/pdf",
      "Content-Length": String(body.byteLength),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16)}`)}`,
    } });
  } catch {
    return NextResponse.json({ error: "Invoice PDF not found or access is no longer available." }, { status: 404, headers });
  }
}

export const GET = observeRouteHandler("document-evidence-download", download);
