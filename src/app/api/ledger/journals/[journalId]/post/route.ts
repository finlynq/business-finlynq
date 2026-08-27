import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal } from "@/modules/identity/session";
import { consumeLedgerMutationRateLimit } from "@/modules/ledger/mutation-rate-limit";
import { postJournal } from "@/modules/ledger/posting-service";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { mutationContext, principalCanWrite } from "@/modules/workspace/write-policy";

const bodySchema = z.object({ expectedContentHash: z.string().regex(/^[0-9a-f]{64}$/i).optional() });
const noStoreHeaders = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ journalId: string }> },
) {
  const requestId = randomUUID();
  if (!validateSameOriginMutation(request)) {
    return NextResponse.json({ error: "The posting request could not be verified." }, { status: 403, headers: noStoreHeaders });
  }
  const [principal, params] = await Promise.all([requestPrincipal(request), context.params]);
  if (!principal || !principalCanWrite(principal) || !z.uuid().safeParse(params.journalId).success) {
    return NextResponse.json({ error: "An authorized organization journal is required." }, { status: 403, headers: noStoreHeaders });
  }
  try {
    const rateLimit = await consumeLedgerMutationRateLimit(principal, "post");
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many posting requests. Try again later." },
        {
          status: 429,
          headers: { ...noStoreHeaders, "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
    }
    let body: unknown;
    try {
      body = await readBoundedJson(request, 16_000);
    } catch (error) {
      if (error instanceof MutationBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
      }
      throw error;
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid posting request." }, { status: 400, headers: noStoreHeaders });
    const result = await postJournal({
      context: mutationContext(principal, requestId),
      journalId: params.journalId,
      expectedContentHash: parsed.data.expectedContentHash,
    });
    return NextResponse.json(result, { headers: noStoreHeaders });
  } catch (error) {
    const expiredSession = demoSessionLeaseLostResponse(error);
    if (expiredSession) return expiredSession;
    console.error("Business Finlynq journal posting failed", { requestId, error });
    return NextResponse.json(
      { error: "The journal could not be posted. Verify its period, balance, approval state, and your posting role.", requestId },
      { status: 409, headers: noStoreHeaders },
    );
  }
}
