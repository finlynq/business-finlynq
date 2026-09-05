import { observeRouteHandler } from "@/observability/request-observability";
import { requestIdFor } from "@/observability/request-correlation";
import { isRetryableDatabaseError } from "@/db/retryable";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requestPrincipal } from "@/modules/identity/session";
import { mutationContext } from "@/modules/workspace/write-policy";
import { downloadBankStatementEvidence } from "@/modules/subledger/evidence-service";
import { storageRetryAfterSeconds } from "@/modules/document-storage/provider";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";

const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
  "X-Robots-Tag": "noindex",
};

async function download(
  request: NextRequest,
  context: { params: Promise<{ statementImportId: string; assetId: string }> },
) {
  try {
    const principal = await requestPrincipal(request);
    if (!principal) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401, headers });
    }
    const parsed = z.object({
      statementImportId: z.uuid(),
      assetId: z.uuid(),
    }).strict().safeParse(await context.params);
    if (!parsed.success) {
      return NextResponse.json({ error: "Evidence not found." }, { status: 404, headers });
    }
    const result = await downloadBankStatementEvidence({
      context: mutationContext(principal, requestIdFor(request), {
        reason: "Download linked bank-statement evidence",
        sourceSurface: "API",
      }),
      ...parsed.data,
    });
    const body = new Uint8Array(result.bytes);
    result.bytes.fill(0);
    return new NextResponse(body, {
      headers: {
        ...headers,
        "Content-Type": result.metadata.mimeType,
        "Content-Length": String(body.byteLength),
        "Content-Disposition": `attachment; filename="evidence"; filename*=UTF-8''${encodeURIComponent(result.metadata.filename).replace(/['()*]/g, (character) => "%" + character.charCodeAt(0).toString(16))}`,
      },
    });
  } catch (error) {
    const retryAfterSeconds = storageRetryAfterSeconds(error)
      ?? (isRetryableDatabaseError(error) ? 1 : null);
    if (retryAfterSeconds !== null) {
      console.warn(JSON.stringify({
        event: "bank-statement-evidence.download.retryable",
        requestId: requestIdFor(request),
        errorCode: "EVIDENCE_RETRYABLE",
        retryAfterSeconds,
      }));
      return NextResponse.json({
        error: `Evidence is temporarily busy. Retry after ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.`,
        code: "EVIDENCE_RETRYABLE",
        retryAfterSeconds,
      }, {
        status: 503,
        headers: { ...headers, "Retry-After": String(retryAfterSeconds) },
      });
    }
    return demoSessionLeaseLostResponse(error)
      ?? NextResponse.json(
        { error: "Evidence not found or access is no longer available." },
        { status: 404, headers },
      );
  }
}

export const GET = observeRouteHandler("document-evidence-download", download);
