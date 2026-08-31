import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { BankingServiceError } from "@/modules/banking/banking-service";
import { consumeBankingRateLimit, type BankingRateAction } from "@/modules/banking/rate-limit";
import { SimpleFinClientError } from "@/modules/banking/simplefin-client";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal, type SessionPrincipal } from "@/modules/identity/session";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { observeRoute } from "@/observability/request-observability";

const bankingHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

export function createBankingMutationRoute<TBody, TResult, TParams = undefined>(options: Readonly<{
  schema: z.ZodType<TBody>;
  paramsSchema?: z.ZodType<TParams>;
  invalidParamsMessage?: string;
  operation: string;
  rateAction: BankingRateAction;
  maximumBytes?: number;
  successStatus?: 200 | 201 | ((result: TResult) => 200 | 201);
  invoke: (
    body: TBody,
    principal: SessionPrincipal,
    requestId: string,
    params: TParams,
  ) => Promise<TResult>;
}>) {
  return async function bankingMutationRoute(
    request: NextRequest,
    routeContext?: { params: Promise<unknown> },
  ) {
    return observeRoute(request, "banking-mutation", async (requestId) => {
      try {
      if (!validateSameOriginMutation(request)) {
        return NextResponse.json({ error: "The banking request could not be verified." }, { status: 403, headers: bankingHeaders });
      }
      const principal = await requestPrincipal(request);
      if (!principal) {
        return NextResponse.json({ error: "Sign in to continue." }, { status: 401, headers: bankingHeaders });
      }
      let params: TParams;
      if (options.paramsSchema) {
        const parsedParams = options.paramsSchema.safeParse(await routeContext?.params);
        if (!parsedParams.success) {
          return NextResponse.json(
            { error: options.invalidParamsMessage ?? "The banking resource identifier is invalid." },
            { status: 400, headers: bankingHeaders },
          );
        }
        params = parsedParams.data;
      } else {
        params = undefined as TParams;
      }
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
      const result = await options.invoke(parsed.data, principal, requestId, params);
      const successStatus = typeof options.successStatus === "function"
        ? options.successStatus(result)
        : options.successStatus ?? 200;
      return NextResponse.json(result, { status: successStatus, headers: bankingHeaders });
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
        logRouteFailure("banking-mutation", requestId, error);
        return NextResponse.json(
          { error: "The banking operation could not be completed safely.", requestId },
          { status: 409, headers: bankingHeaders },
        );
      }
    });
  };
}
