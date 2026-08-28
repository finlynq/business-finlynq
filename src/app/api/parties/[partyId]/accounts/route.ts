import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal } from "@/modules/identity/session";
import { consumeLedgerMutationRateLimit } from "@/modules/ledger/mutation-rate-limit";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { addPartyAccount } from "@/modules/parties/party-service";
import { mutationContext, principalCanWrite } from "@/modules/workspace/write-policy";

const bodySchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(180),
  account: z.object({
    legalEntityId: z.uuid(),
    ledgerId: z.uuid(),
    role: z.enum(["CUSTOMER", "SUPPLIER"]),
    accountNumber: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/),
    controlAccountId: z.uuid(),
    transactionCurrency: z.string().trim().regex(/^[A-Za-z]{3}$/).nullable().optional(),
  }),
});
const noStoreHeaders = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ partyId: string }> },
) {
  const requestId = randomUUID();
  if (!validateSameOriginMutation(request)) {
    return NextResponse.json(
      { error: "The party account request could not be verified." },
      { status: 403, headers: noStoreHeaders },
    );
  }
  const principal = await requestPrincipal(request);
  if (!principal || !principalCanWrite(principal)) {
    return NextResponse.json(
      { error: "A writable organization session is required." },
      { status: 403, headers: noStoreHeaders },
    );
  }

  try {
    const parsedPartyId = z.uuid().safeParse((await params).partyId);
    if (!parsedPartyId.success) {
      return NextResponse.json(
        { error: "Party identifier is invalid." },
        { status: 400, headers: noStoreHeaders },
      );
    }
    const partyId = parsedPartyId.data;
    const rateLimit = await consumeLedgerMutationRateLimit(principal, "party");
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many party requests. Try again later." },
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
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Party account fields are invalid." },
        { status: 400, headers: noStoreHeaders },
      );
    }
    const result = await addPartyAccount({
      context: mutationContext(principal, requestId),
      partyId,
      ...parsed.data,
    });
    return NextResponse.json(result, {
      status: result.idempotentReplay ? 200 : 201,
      headers: noStoreHeaders,
    });
  } catch (error) {
    const expiredSession = demoSessionLeaseLostResponse(error);
    if (expiredSession) return expiredSession;
    console.error("Business Finlynq party-account attachment failed", { requestId, error });
    return NextResponse.json(
      {
        error: "The entity role could not be attached. Verify the party, account number, control setup, currency, and your assigned role.",
        requestId,
      },
      { status: 409, headers: noStoreHeaders },
    );
  }
}
