import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal } from "@/modules/identity/session";
import { createManualJournal } from "@/modules/ledger/journal-service";
import { consumeLedgerMutationRateLimit } from "@/modules/ledger/mutation-rate-limit";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { mutationContext, principalCanWrite } from "@/modules/workspace/write-policy";

const bodySchema = z.object({
  ledgerId: z.uuid(),
  legalEntityId: z.uuid(),
  periodId: z.uuid(),
  accountingDate: z.iso.date(),
  purpose: z.enum(["ROUTINE", "ADJUSTING", "OPENING", "CLOSING", "REVALUATION", "TAX_ADJUSTMENT"]),
  description: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(200),
  lines: z.array(z.object({
    accountCombinationId: z.uuid(),
    debitFunctional: z.string().max(50),
    creditFunctional: z.string().max(50),
    transactionCurrency: z.string().max(3),
    debitTransaction: z.string().max(50),
    creditTransaction: z.string().max(50),
    fxRate: z.string().max(60),
    fxRateSource: z.string().max(100),
    fxRateEffectiveAt: z.string().max(50),
    memo: z.string().max(500).optional(),
  })).min(2).max(200),
});
const noStoreHeaders = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  if (!validateSameOriginMutation(request)) {
    return NextResponse.json({ error: "The journal request could not be verified." }, { status: 403, headers: noStoreHeaders });
  }
  const principal = await requestPrincipal(request);
  if (!principal || !principalCanWrite(principal)) {
    return NextResponse.json({ error: "A writable organization session is required." }, { status: 403, headers: noStoreHeaders });
  }
  try {
    const rateLimit = await consumeLedgerMutationRateLimit(principal, "create");
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many journal requests. Try again later." },
        {
          status: 429,
          headers: { ...noStoreHeaders, "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
    }
    let body: unknown;
    try {
      body = await readBoundedJson(request, 128_000);
    } catch (error) {
      if (error instanceof MutationBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
      }
      throw error;
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Journal fields are invalid." }, { status: 400, headers: noStoreHeaders });
    }
    const result = await createManualJournal({
      context: mutationContext(principal, requestId),
      ...parsed.data,
      origin: "USER",
    });
    return NextResponse.json(result, { status: result.idempotentReplay ? 200 : 201, headers: noStoreHeaders });
  } catch (error) {
    const expiredSession = demoSessionLeaseLostResponse(error);
    if (expiredSession) return expiredSession;
    console.error("Business Finlynq journal creation failed", { requestId, error });
    return NextResponse.json(
      { error: "The journal could not be saved. Verify the ledger, period, accounts, balance, and your assigned role.", requestId },
      { status: 409, headers: noStoreHeaders },
    );
  }
}
