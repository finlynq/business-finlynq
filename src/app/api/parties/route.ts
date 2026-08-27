import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal, transactionAuthMethod } from "@/modules/identity/session";
import { consumeLedgerMutationRateLimit } from "@/modules/ledger/mutation-rate-limit";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { createParty } from "@/modules/parties/party-service";

const bodySchema = z.object({
  partyNumber: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/),
  displayName: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(180),
  internalLegalEntityId: z.uuid().optional(),
  address: z.object({
    kind: z.enum(["BILLING", "SHIPPING", "REMIT_TO", "REGISTERED"]),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    region: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().min(1).max(30),
    countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/),
    validFrom: z.iso.date(),
  }).optional(),
});
const noStoreHeaders = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  if (!validateSameOriginMutation(request)) {
    return NextResponse.json(
      { error: "The party request could not be verified." },
      { status: 403, headers: noStoreHeaders },
    );
  }
  const principal = await requestPrincipal(request);
  if (!principal || principal.sessionMode !== "real") {
    return NextResponse.json(
      { error: "A real organization session is required." },
      { status: 403, headers: noStoreHeaders },
    );
  }

  try {
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
      body = await readBoundedJson(request, 32_000);
    } catch (error) {
      if (error instanceof MutationBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
      }
      throw error;
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Party fields are invalid." },
        { status: 400, headers: noStoreHeaders },
      );
    }
    const result = await createParty({
      context: {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        sessionId: principal.sessionId,
        requestId,
        authMethod: transactionAuthMethod(principal),
        sourceSurface: "UI",
      },
      ...parsed.data,
    });
    return NextResponse.json(result, {
      status: result.idempotentReplay ? 200 : 201,
      headers: noStoreHeaders,
    });
  } catch (error) {
    console.error("Business Finlynq party creation failed", { requestId, error });
    return NextResponse.json(
      {
        error: "The party could not be saved. Verify its number, master data, encryption setup, and your assigned role.",
        requestId,
      },
      { status: 409, headers: noStoreHeaders },
    );
  }
}
