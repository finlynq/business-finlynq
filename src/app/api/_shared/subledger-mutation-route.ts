import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";
import type { TenantTransactionContext } from "@/db/transaction";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal } from "@/modules/identity/session";
import { consumeLedgerMutationRateLimit } from "@/modules/ledger/mutation-rate-limit";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { mutationContext, principalCanWrite } from "@/modules/workspace/write-policy";

const noStoreHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
};

type MutationRateAction = Parameters<typeof consumeLedgerMutationRateLimit>[1];
type MutationResult = Readonly<{ idempotentReplay: boolean }>;

type SubledgerMutationRouteOptions<TBody extends Readonly<{ kind: string }>, TResult extends MutationResult> = Readonly<{
  schema: z.ZodType<TBody>;
  expectedKind: TBody["kind"];
  operation: string;
  rateAction: MutationRateAction;
  maximumBytes: number;
  successStatus?: 200 | 201;
  invalidMessage: string;
  failureMessage: string;
  auditReason?: (body: TBody) => string;
  invoke: (body: TBody, context: TenantTransactionContext) => Promise<TResult>;
}>;

/**
 * Shared HTTP boundary for source-owned AR/AP commands. Accounting state and
 * authorization remain in the domain service; this layer only establishes a
 * verified session, a bounded strict command, and an auditable request context.
 */
export function createSubledgerMutationRoute<
  TBody extends Readonly<{ kind: string }>,
  TResult extends MutationResult,
>(options: SubledgerMutationRouteOptions<TBody, TResult>) {
  return async function subledgerMutationRoute(request: NextRequest) {
    const requestId = randomUUID();
    if (!validateSameOriginMutation(request)) {
      return NextResponse.json(
        { error: "The accounting request could not be verified." },
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
      const rateLimit = await consumeLedgerMutationRateLimit(principal, options.rateAction);
      if (!rateLimit.allowed) {
        return NextResponse.json(
          { error: "Too many accounting requests. Try again later." },
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
          return NextResponse.json(
            { error: error.message },
            { status: error.status, headers: noStoreHeaders },
          );
        }
        throw error;
      }

      const parsed = options.schema.safeParse(unparsedBody);
      if (!parsed.success || parsed.data.kind !== options.expectedKind) {
        return NextResponse.json(
          { error: options.invalidMessage },
          { status: 400, headers: noStoreHeaders },
        );
      }

      const result = await options.invoke(
        parsed.data,
        mutationContext(principal, requestId, {
          reason: options.auditReason?.(parsed.data),
          sourceSurface: "API",
        }),
      );
      return NextResponse.json(result, {
        status: result.idempotentReplay ? 200 : (options.successStatus ?? 201),
        headers: noStoreHeaders,
      });
    } catch (error) {
      const expiredSession = demoSessionLeaseLostResponse(error);
      if (expiredSession) return expiredSession;
      // Command bodies can contain accounting and party facts. Keep logs and
      // responses free from the body and the domain error's potentially
      // sensitive details while retaining a correlation ID for operations.
      console.error("Business Finlynq subledger mutation failed", {
        requestId,
        operation: options.operation,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return NextResponse.json(
        { error: options.failureMessage, requestId },
        { status: 409, headers: noStoreHeaders },
      );
    }
  };
}
