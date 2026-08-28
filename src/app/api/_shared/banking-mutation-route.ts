import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";
import { BankingServiceError } from "@/modules/banking/banking-service";
import { consumeBankingRateLimit, type BankingRateAction } from "@/modules/banking/rate-limit";
import { SimpleFinClientError } from "@/modules/banking/simplefin-client";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal, type SessionPrincipal } from "@/modules/identity/session";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";

const bankingHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

export function createBankingMutationRoute<TBody, TResult>(options: Readonly<{
  schema: z.ZodType<TBody>;
  operation: string;
  rateAction: BankingRateAction;
  maximumBytes?: number;
  successStatus?: 200 | 201;
  invoke: (body: TBody, principal: SessionPrincipal, requestId: string) => Promise<TResult>;
}>) {
  return async function bankingMutationRoute(request: NextRequest) {
    const requestId = randomUUID();
    if (!validateSameOriginMutation(request)) {
      return NextResponse.json({ error: "The banking request could not be verified." }, { status: 403, headers: bankingHeaders });
    }
    const principal = await requestPrincipal(request);
    if (!principal) {
      return NextResponse.json({ error: "Sign in to continue." }, { status: 401, headers: bankingHeaders });
    }
    try {
      const rateLimit = await consumeBankingRateLimit(principal, options.rateAction);
      if (!rateLimit.allowed) {
        return NextResponse.json(
          { error: "Too many banking requests. Try again later." },
          { status: 429, headers: { ...bankingHeaders, "Retry-After": String(rateLimit.retryAfterSeconds) } },
        );
      }
      let unparsed: unknown;
      try {
        unparsed = await readBoundedJson(request, options.maximumBytes ?? 32_000);
      } catch (error) {
        if (error instanceof MutationBodyError) {
          return NextResponse.json({ error: error.message }, { status: error.status, headers: bankingHeaders });
        }
        throw error;
      }
      const parsed = options.schema.safeParse(unparsed);
      if (!parsed.success) {
        return NextResponse.json({ error: "Review the banking fields and try again." }, { status: 400, headers: bankingHeaders });
      }
      const result = await options.invoke(parsed.data, principal, requestId);
      return NextResponse.json(result, { status: options.successStatus ?? 200, headers: bankingHeaders });
    } catch (error) {
      const expiredSession = demoSessionLeaseLostResponse(error);
      if (expiredSession) return expiredSession;
      if (error instanceof BankingServiceError) {
        const headers = error.retryAfterSeconds === undefined
          ? bankingHeaders
          : { ...bankingHeaders, "Retry-After": String(error.retryAfterSeconds) };
        return NextResponse.json({ error: error.message, code: error.code, requestId }, { status: error.status, headers });
      }
      if (error instanceof SimpleFinClientError) {
        const status = error.code === "PROVIDER_TIMEOUT" ? 504
          : error.code === "INVALID_SETUP_TOKEN" || error.code === "UNSAFE_ENDPOINT" ? 400
            : 502;
        return NextResponse.json({ error: error.message, code: error.code, requestId }, { status, headers: bankingHeaders });
      }
      console.error("Business Finlynq banking mutation failed", {
        requestId,
        operation: options.operation,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return NextResponse.json(
        { error: "The banking operation could not be completed safely.", requestId },
        { status: 409, headers: bankingHeaders },
      );
    }
  };
}
