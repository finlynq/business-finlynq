import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import type { TenantTransactionContext } from "@/db/transaction";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import {
  requestPrincipal,
  type SessionPrincipal,
} from "@/modules/identity/session";
import { consumeLedgerMutationRateLimit } from "@/modules/ledger/mutation-rate-limit";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { mutationContext, principalCanWrite } from "@/modules/workspace/write-policy";
import { observeRoute } from "@/observability/request-observability";

const noStoreHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
};

type MutationRateAction = Parameters<typeof consumeLedgerMutationRateLimit>[1];
type MutationResult = Readonly<{ idempotentReplay: boolean }>;
type MutationRejection = Readonly<{
  error: string;
  status: 400 | 403;
}>;

type MutationRouteOptions<TBody, TResult extends MutationResult, TParams> = Readonly<{
  schema: z.ZodType<TBody>;
  expectedKind?: string;
  operation: string;
  rateAction: MutationRateAction;
  maximumBytes: number;
  successStatus?: 200 | 201;
  sameOriginMessage?: string;
  unauthorizedMessage?: string;
  rateLimitMessage?: string;
  invalidMessage: string;
  failureMessage: string;
  auditReason?: (body: TBody) => string;
  authorize?: (
    body: TBody,
    principal: SessionPrincipal,
    params: TParams,
  ) => MutationRejection | undefined;
  invoke: (
    body: TBody,
    context: TenantTransactionContext,
    params: TParams,
  ) => Promise<TResult>;
}>;

type StaticMutationRouteOptions<TBody, TResult extends MutationResult> =
  MutationRouteOptions<TBody, TResult, undefined> & Readonly<{
    paramsSchema?: undefined;
    invalidParamsMessage?: never;
    invalidParamsStatus?: never;
  }>;

type DynamicMutationRouteOptions<TBody, TResult extends MutationResult, TParams> =
  MutationRouteOptions<TBody, TResult, TParams> & Readonly<{
    paramsSchema: z.ZodType<TParams>;
    invalidParamsMessage: string;
    invalidParamsStatus: 400 | 403;
  }>;

type AnyMutationRouteOptions<TBody, TResult extends MutationResult, TParams> =
  MutationRouteOptions<TBody, TResult, TParams> & Readonly<{
    paramsSchema?: z.ZodType<TParams>;
    invalidParamsMessage?: string;
    invalidParamsStatus?: 400 | 403;
  }>;

function jsonError(error: string, status: number, headers = noStoreHeaders) {
  return NextResponse.json({ error }, { status, headers });
}

export function createMutationRoute<TBody, TResult extends MutationResult>(
  options: StaticMutationRouteOptions<TBody, TResult>,
): (request: NextRequest) => Promise<NextResponse>;
export function createMutationRoute<TBody, TResult extends MutationResult, TParams>(
  options: DynamicMutationRouteOptions<TBody, TResult, TParams>,
): (
  request: NextRequest,
  context: { params: Promise<TParams> },
) => Promise<NextResponse>;
export function createMutationRoute<TBody, TResult extends MutationResult, TParams>(
  options: AnyMutationRouteOptions<TBody, TResult, TParams>,
) {
  return async function mutationRoute(
    request: NextRequest,
    routeContext?: { params: Promise<unknown> },
  ) {
    return observeRoute(request, "accounting-mutation", async (requestId) => {
      try {
      if (!validateSameOriginMutation(request)) {
        return jsonError(
          options.sameOriginMessage ?? "The accounting request could not be verified.",
          403,
        );
      }

      const principal = await requestPrincipal(request);
      if (!principal || !principalCanWrite(principal)) {
        return jsonError(
          options.unauthorizedMessage ?? "A writable organization session is required.",
          403,
        );
      }

      let params: TParams;
      if (options.paramsSchema) {
        const parsedParams = options.paramsSchema.safeParse(await routeContext?.params);
        if (!parsedParams.success) {
          return jsonError(
            options.invalidParamsMessage ?? "Route parameters are invalid.",
            options.invalidParamsStatus ?? 400,
          );
        }
        params = parsedParams.data;
      } else {
        params = undefined as TParams;
      }

      const rateLimit = await consumeLedgerMutationRateLimit(principal, options.rateAction);
      if (!rateLimit.allowed) {
        return NextResponse.json(
          {
            error: options.rateLimitMessage ??
              "Too many accounting requests. Try again later.",
          },
          {
            status: 429,
            headers: {
              ...noStoreHeaders,
              "Retry-After": String(rateLimit.retryAfterSeconds),
            },
          },
        );
      }

      let unparsedBody: unknown;
      try {
        unparsedBody = await readBoundedJson(request, options.maximumBytes);
      } catch (error) {
        if (error instanceof MutationBodyError) {
          return jsonError(error.message, error.status);
        }
        throw error;
      }

      const parsed = options.schema.safeParse(unparsedBody);
      const parsedKind = parsed.success && typeof parsed.data === "object" &&
          parsed.data !== null && "kind" in parsed.data
        ? parsed.data.kind
        : undefined;
      if (!parsed.success ||
          (options.expectedKind !== undefined && parsedKind !== options.expectedKind)) {
        return jsonError(options.invalidMessage, 400);
      }

      const rejection = options.authorize?.(parsed.data, principal, params);
      if (rejection) return jsonError(rejection.error, rejection.status);

      const result = await options.invoke(
        parsed.data,
        mutationContext(principal, requestId, {
          reason: options.auditReason?.(parsed.data),
          sourceSurface: "API",
        }),
        params,
      );
      return NextResponse.json(result, {
        status: result.idempotentReplay ? 200 : (options.successStatus ?? 201),
        headers: noStoreHeaders,
      });
      } catch (error) {
        const expiredSession = demoSessionLeaseLostResponse(error);
        if (expiredSession) return expiredSession;
        logRouteFailure("subledger-mutation", requestId, error);
        return NextResponse.json(
          { error: options.failureMessage, requestId },
          { status: 409, headers: noStoreHeaders },
        );
      }
    });
  };
}

/** Compatibility name for existing AR/AP source-owned command routes. */
export const createSubledgerMutationRoute = createMutationRoute;
