import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { observeRouteHandler } from "@/observability/request-observability";
import { requestIdFor } from "@/observability/request-correlation";
import { requestPrincipal } from "@/modules/identity/session";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { consumeLedgerMutationRateLimit } from "@/modules/ledger/mutation-rate-limit";
import { mutationContext } from "@/modules/workspace/write-policy";
import { prepareAndUploadPdf } from "@/modules/document-storage/prepare-pdf-upload";
import { MAX_PDF_PREPARATION_BYTES, preparePdfUploadSchema } from "@/modules/document-storage/model";
import { StorageError } from "@/modules/document-storage/provider";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };
async function post(request: NextRequest) {
  try {
    if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "real") return NextResponse.json({ error: "Sign in to a real account to prepare PDFs." }, { status: 401, headers });
    const rate = await consumeLedgerMutationRateLimit(principal, "create");
    if (!rate.allowed) return NextResponse.json({ error: "Too many document requests. Try again later." }, { status: 429, headers: { ...headers, "Retry-After": String(rate.retryAfterSeconds) } });
    const input = preparePdfUploadSchema.parse(await readBoundedJson(request, 4 * Math.ceil(MAX_PDF_PREPARATION_BYTES / 3) + 4096));
    const result = await prepareAndUploadPdf(mutationContext(principal, requestIdFor(request), { reason: "Prepare and retain oversized PDF", sourceSurface: "API" }), input);
    return NextResponse.json(result, { headers });
  } catch (error) {
    if (error instanceof MutationBodyError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
    if (error instanceof StorageError) return NextResponse.json({ error: error.message, code: error.code }, { status: 409, headers });
    if (error instanceof z.ZodError) return NextResponse.json({ error: `PDF preparation accepts a PDF source up to ${MAX_PDF_PREPARATION_BYTES} bytes (8 MiB). Check the exact file size, SHA-256 and base64, then retry.`, code: "STORAGE_PDF_INPUT_INVALID" }, { status: 400, headers });
    return NextResponse.json({ error: "PDF preparation failed. Retry or export a smaller unsigned PDF." }, { status: 409, headers });
  }
}
export const POST = observeRouteHandler("document-storage", post);
