import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isRetryableDatabaseError } from "@/db/retryable";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import { requestPrincipal } from "@/modules/identity/session";
import { mutationContext } from "@/modules/workspace/write-policy";
import { storageRetryAfterSeconds } from "@/modules/document-storage/provider";
import { downloadPostedJournalEvidence } from "@/modules/ledger/journal-evidence";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";

const safeHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
  "X-Robots-Tag": "noindex",
};

async function download(request: NextRequest, context: { params: Promise<{ journalId: string; assetId: string }> }) {
  try {
    const principal = await requestPrincipal(request);
    if (!principal) return NextResponse.json({ error: "Authentication required." }, { status: 401, headers: safeHeaders });
    const ids = z.object({ journalId: z.uuid(), assetId: z.uuid() }).safeParse(await context.params);
    if (!ids.success) return NextResponse.json({ error: "Evidence not found." }, { status: 404, headers: safeHeaders });
    const result = await downloadPostedJournalEvidence(
      mutationContext(principal, requestIdFor(request), {
        reason: "Download posted-journal evidence", sourceSurface: "API",
      }),
      ids.data.journalId,
      ids.data.assetId,
    );
    const disposition = request.nextUrl.searchParams.get("disposition") === "inline"
      && ["application/pdf", "image/png", "image/jpeg"].includes(result.metadata.asset.mimeType)
      ? "inline" : "attachment";
    const body = new Uint8Array(result.bytes);
    result.bytes.fill(0);
    const filename = encodeURIComponent(result.metadata.asset.filename)
      .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16)}`);
    return new NextResponse(body, { headers: {
      ...safeHeaders,
      "Content-Type": result.metadata.asset.mimeType,
      "Content-Length": String(body.byteLength),
      "Content-Disposition": `${disposition}; filename="evidence"; filename*=UTF-8''${filename}`,
    } });
  } catch (error) {
    const retryAfterSeconds = storageRetryAfterSeconds(error) ?? (isRetryableDatabaseError(error) ? 1 : null);
    if (retryAfterSeconds !== null) return NextResponse.json({
      error: "Evidence is temporarily busy. Retry after the indicated interval.",
      code: "EVIDENCE_RETRYABLE",
      retryAfterSeconds,
    }, {
      status: 503,
      headers: { ...safeHeaders, "Retry-After": String(retryAfterSeconds) },
    });
    return demoSessionLeaseLostResponse(error)
      ?? NextResponse.json({ error: "This journal evidence is unavailable or access has changed." }, {
        status: 404, headers: safeHeaders,
      });
  }
}

export const GET = observeRouteHandler("journal-evidence-download", download);
