import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import {
  hasRecentStepUp,
  requestPrincipal,
  transactionAuthMethod,
} from "@/modules/identity/session";
import { consumeLedgerMutationRateLimit } from "@/modules/ledger/mutation-rate-limit";
import { transitionFiscalPeriod } from "@/modules/ledger/period-service";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";

const bodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  toState: z.enum(["OPEN", "ADJUSTMENT_ONLY", "HARD_CLOSED", "SEALED"]),
  reason: z.string().trim().min(20).max(500),
  idempotencyKey: z.string().trim().min(1).max(180),
});
const noStoreHeaders = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ periodId: string }> },
) {
  const requestId = randomUUID();
  if (!validateSameOriginMutation(request)) {
    return NextResponse.json(
      { error: "The period request could not be verified." },
      { status: 403, headers: noStoreHeaders },
    );
  }
  const [principal, params] = await Promise.all([requestPrincipal(request), context.params]);
  if (!principal || principal.sessionMode !== "real" || !z.uuid().safeParse(params.periodId).success) {
    return NextResponse.json(
      { error: "An authorized organization period is required." },
      { status: 403, headers: noStoreHeaders },
    );
  }

  try {
    const rateLimit = await consumeLedgerMutationRateLimit(principal, "period");
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many period-control requests. Try again later." },
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
      return NextResponse.json({ error: "Period transition fields are invalid." }, { status: 400, headers: noStoreHeaders });
    }
    if ((parsed.data.toState === "OPEN" || parsed.data.toState === "SEALED") && !hasRecentStepUp(principal)) {
      return NextResponse.json(
        { error: "A current MFA step-up is required to reopen or seal a period." },
        { status: 403, headers: noStoreHeaders },
      );
    }
    const result = await transitionFiscalPeriod({
      context: {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        sessionId: principal.sessionId,
        requestId,
        authMethod: transactionAuthMethod(principal),
        sourceSurface: "UI",
        reason: parsed.data.reason,
      },
      periodId: params.periodId,
      expectedVersion: parsed.data.expectedVersion,
      toState: parsed.data.toState,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    return NextResponse.json(result, { headers: noStoreHeaders });
  } catch (error) {
    console.error("Business Finlynq period transition failed", { requestId, error });
    return NextResponse.json(
      {
        error: "The period could not be changed. Refresh it, resolve unposted journals, verify your role, and complete MFA for reopen or seal.",
        requestId,
      },
      { status: 409, headers: noStoreHeaders },
    );
  }
}
