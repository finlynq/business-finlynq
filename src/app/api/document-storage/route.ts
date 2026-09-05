import { observeRouteHandler } from "@/observability/request-observability";
import { requestIdFor } from "@/observability/request-correlation";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requestPrincipal } from "@/modules/identity/session";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { consumeLedgerMutationRateLimit } from "@/modules/ledger/mutation-rate-limit";
import { mutationContext } from "@/modules/workspace/write-policy";
import { disconnectStorage, listStorageConnections, startStorageConnection } from "@/modules/document-storage/connections";
import { claimInboxDocument, listDocumentInbox, retryDocumentFiling, reviewInboxDocument, syncDocumentInbox } from "@/modules/document-storage/inbox";
import { uploadInboxDocument } from "@/modules/document-storage/upload";
import { claimInboxSchema, connectStorageSchema, listInboxSchema, retryFilingSchema, reviewInboxSchema, syncInboxSchema, uploadInboxSchema } from "@/modules/document-storage/model";
import { StorageError } from "@/modules/document-storage/provider";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };
function failure(error: unknown) {
  if (error instanceof MutationBodyError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
  return NextResponse.json({ error: error instanceof StorageError ? error.message : "The document request could not be completed. Check your permissions and the supplied fields." }, { status: 409, headers });
}
async function list(request: NextRequest) {
  try {
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "real") return NextResponse.json({ error: "Sign in to a real account to use document storage." }, { status: 401, headers });
    const context = mutationContext(principal, requestIdFor(request));
    const query = Object.fromEntries(request.nextUrl.searchParams);
    const filter = listInboxSchema.parse({ ...query, ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}) });
    const [connections, inbox] = await Promise.all([listStorageConnections(context), listDocumentInbox(context, filter)]);
    return NextResponse.json({ connections, ...inbox }, { headers });
  } catch (error) { return failure(error); }
}
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), input: connectStorageSchema }).strict(),
  z.object({ action: z.literal("disconnect"), input: syncInboxSchema }).strict(),
  z.object({ action: z.literal("sync"), input: syncInboxSchema }).strict(),
  z.object({ action: z.literal("retry"), input: retryFilingSchema }).strict(),
  z.object({ action: z.literal("claim"), input: claimInboxSchema }).strict(),
  z.object({ action: z.literal("review"), input: reviewInboxSchema }).strict(),
  z.object({ action: z.literal("upload"), input: uploadInboxSchema }).strict(),
]);
async function mutate(request: NextRequest) {
  try {
    if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "real") return NextResponse.json({ error: "Sign in to a real account to use document storage." }, { status: 401, headers });
    const rate = await consumeLedgerMutationRateLimit(principal, "create");
    if (!rate.allowed) return NextResponse.json({ error: "Too many document requests. Try again later." }, { status: 429, headers: { ...headers, "Retry-After": String(rate.retryAfterSeconds) } });
    const body = actionSchema.parse(await readBoundedJson(request, 3 * 1024 * 1024));
    const context = mutationContext(principal, requestIdFor(request), { reason: "Manage cloud document inbox", sourceSurface: "API" });
    let result;
    switch (body.action) {
      case "connect": result = await startStorageConnection(principal, body.input); break;
      case "disconnect": result = await disconnectStorage(context, body.input.connectionId); break;
      case "sync": result = await syncDocumentInbox(context, body.input); break;
      case "retry": result = await retryDocumentFiling(context, body.input); break;
      case "claim": result = await claimInboxDocument(context, body.input); break;
      case "review": result = await reviewInboxDocument(context, body.input); break;
      case "upload": result = await uploadInboxDocument(context, body.input); break;
    }
    return NextResponse.json(result, { headers });
  } catch (error) { return failure(error); }
}

export const GET = observeRouteHandler("document-storage", list);
export const POST = observeRouteHandler("document-storage", mutate);
