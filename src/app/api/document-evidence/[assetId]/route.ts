import { observeRouteHandler } from "@/observability/request-observability";
import { requestIdFor } from "@/observability/request-correlation";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requestPrincipal } from "@/modules/identity/session";
import { mutationContext } from "@/modules/workspace/write-policy";
import { downloadDocumentEvidence } from "@/modules/subledger/evidence-service";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'", "X-Robots-Tag": "noindex" };
async function download(request: NextRequest, context: { params: Promise<{ assetId: string }> }) {
  try {
    const principal = await requestPrincipal(request);
    if (!principal) return NextResponse.json({ error: "Authentication required." }, { status: 401, headers });
    const params = await context.params;
    const parsed = z.object({ assetId: z.uuid(), sourceDocumentId: z.uuid() }).safeParse({
      assetId: params.assetId, sourceDocumentId: request.nextUrl.searchParams.get("sourceDocumentId"),
    });
    if (!parsed.success) return NextResponse.json({ error: "Evidence not found." }, { status: 404, headers });
    const result = await downloadDocumentEvidence({
      context: mutationContext(principal, requestIdFor(request), { reason: "Download linked document evidence", sourceSurface: "API" }),
      ...parsed.data,
    });
    // Copy before zeroing the decrypted application buffer.
    const body = new Uint8Array(result.bytes);
    result.bytes.fill(0);
    return new NextResponse(body, { headers: {
      ...headers, "Content-Type": result.metadata.mimeType,
      "Content-Length": String(body.byteLength),
      "Content-Disposition": `attachment; filename="evidence"; filename*=UTF-8''${encodeURIComponent(result.metadata.filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`,
    } });
  } catch (error) {
    return demoSessionLeaseLostResponse(error)
      ?? NextResponse.json({ error: "Evidence not found or access is no longer available." }, { status: 404, headers });
  }
}

export const GET = observeRouteHandler("document-evidence-download", download);
