import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";
import type { RouteFailureOperation } from "@/app/api/_shared/route-failure-log";
import { isAuthorizationDeniedError } from "@/modules/identity/authorization-error";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal, type SessionPrincipal } from "@/modules/identity/session";
import { consumeLedgerMutationRateLimit } from "@/modules/ledger/mutation-rate-limit";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { TaxFilingError } from "@/modules/tax/filing-service";
import { principalCanWrite } from "@/modules/workspace/write-policy";
import { observeRoute } from "@/observability/request-observability";

const headers = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

export function createTaxMutationRoute<TBody, TResult extends { idempotentReplay: boolean }>(options: Readonly<{
  schema: z.ZodType<TBody>;
  operation: RouteFailureOperation;
  maximumBytes?: number;
  reportFailure: (requestId: string, error: unknown) => void;
  invoke: (body: TBody, principal: SessionPrincipal, requestId: string) => Promise<TResult>;
}>) {
  return async function taxMutationRoute(request: NextRequest) {
    return observeRoute(request, options.operation, async (requestId) => {
      try {
        if (!validateSameOriginMutation(request)) {
          return NextResponse.json({ error: "The tax request could not be verified." }, { status: 403, headers });
        }
        const principal = await requestPrincipal(request);
        if (!principal || !principalCanWrite(principal)) {
          return NextResponse.json({ error: "A writable organization session is required." }, { status: 403, headers });
        }
        const rateLimit = await consumeLedgerMutationRateLimit(principal, "create");
        if (!rateLimit.allowed) {
          return NextResponse.json(
            { error: "Too many tax requests. Try again later." },
            { status: 429, headers: { ...headers, "Retry-After": String(rateLimit.retryAfterSeconds) } },
          );
        }
        let unparsed: unknown;
        try {
          unparsed = await readBoundedJson(request, options.maximumBytes ?? 128_000);
        } catch (error) {
          if (error instanceof MutationBodyError) {
            return NextResponse.json({ error: error.message }, { status: error.status, headers });
          }
          throw error;
        }
        const parsed = options.schema.safeParse(unparsed);
        if (!parsed.success) {
          return NextResponse.json({ error: "Review the tax fields and try again." }, { status: 400, headers });
        }
        const result = await options.invoke(parsed.data, principal, requestId);
        return NextResponse.json(result, {
          status: result.idempotentReplay ? 200 : 201,
          headers,
        });
      } catch (error) {
        const expiredSession = demoSessionLeaseLostResponse(error);
        if (expiredSession) return expiredSession;
        if (error instanceof TaxFilingError) {
          return NextResponse.json(
            { error: error.message, code: error.code, requestId },
            { status: error.status, headers },
          );
        }
        if (isAuthorizationDeniedError(error)) {
          return NextResponse.json(
            { error: "The authenticated user is not authorized for this tax operation." },
            { status: 403, headers },
          );
        }
        options.reportFailure(requestId, error);
        return NextResponse.json(
          { error: "The tax operation could not be completed safely.", requestId },
          { status: 409, headers },
        );
      }
    });
  };
}
