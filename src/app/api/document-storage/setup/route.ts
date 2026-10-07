import { NextRequest, NextResponse } from "next/server";
import { observeRouteHandler } from "@/observability/request-observability";
import { requestPrincipal } from "@/modules/identity/session";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { consumeLedgerMutationRateLimit } from "@/modules/ledger/mutation-rate-limit";
import { approveStorageSetup } from "@/modules/document-storage/setup";
import { approveStorageSetupSchema } from "@/modules/document-storage/model";
import { StorageError } from "@/modules/document-storage/provider";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };
async function approve(request: NextRequest) {
  try {
    if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "real") return NextResponse.json({ error: "Sign in with the account that requested this setup." }, { status: 401, headers });
    const rate = await consumeLedgerMutationRateLimit(principal, "create");
    if (!rate.allowed) return NextResponse.json({ error: "Too many setup requests. Retry shortly." }, { status: 429, headers: { ...headers, "Retry-After": String(rate.retryAfterSeconds) } });
    return NextResponse.json(await approveStorageSetup(principal, approveStorageSetupSchema.parse(await readBoundedJson(request, 16 * 1024))), { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof StorageError || error instanceof MutationBodyError ? error.message : "The setup could not be completed. Check your access and retry the same request.", ...(error instanceof StorageError ? { code: error.code } : {}) }, { status: error instanceof MutationBodyError ? error.status : 409, headers });
  }
}
export const POST = observeRouteHandler("document-storage", approve);
