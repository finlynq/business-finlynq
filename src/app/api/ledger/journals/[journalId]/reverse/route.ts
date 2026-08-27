import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal } from "@/modules/identity/session";
import { reversePostedJournal } from "@/modules/ledger/journal-service";
import { consumeLedgerMutationRateLimit } from "@/modules/ledger/mutation-rate-limit";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { mutationContext, principalCanWrite } from "@/modules/workspace/write-policy";

const bodySchema = z.object({
  periodId: z.uuid(),
  accountingDate: z.iso.date(),
  description: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(200),
});
const noStoreHeaders = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ journalId: string }> },
) {
  const requestId = randomUUID();
  if (!validateSameOriginMutation(request)) {
    return NextResponse.json({ error: "The reversal request could not be verified." }, { status: 403, headers: noStoreHeaders });
  }
  const [principal, params] = await Promise.all([requestPrincipal(request), context.params]);
  if (!principal || !principalCanWrite(principal) || !z.uuid().safeParse(params.journalId).success) {
    return NextResponse.json({ error: "An authorized organization journal is required." }, { status: 403, headers: noStoreHeaders });
  }
  try {
    const rateLimit = await consumeLedgerMutationRateLimit(principal, "reverse");
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many reversal requests. Try again later." },
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
    if (!parsed.success) return NextResponse.json({ error: "Invalid reversal request." }, { status: 400, headers: noStoreHeaders });
    const result = await reversePostedJournal({
      context: mutationContext(principal, requestId, { reason: parsed.data.reason }),
      originalJournalId: params.journalId,
      ...parsed.data,
    });
    return NextResponse.json(result, { status: result.idempotentReplay ? 200 : 201, headers: noStoreHeaders });
  } catch (error) {
    console.error("Business Finlynq journal reversal failed", { requestId, error });
    return NextResponse.json(
      { error: "The journal could not be reversed. Verify ownership, the target period, and your reversal/posting roles.", requestId },
      { status: 409, headers: noStoreHeaders },
    );
  }
}
