import { z } from "zod";
import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { hasRecentStepUp } from "@/modules/identity/session";
import { transitionFiscalPeriod } from "@/modules/ledger/period-service";

const bodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  toState: z.enum(["OPEN", "ADJUSTMENT_ONLY", "HARD_CLOSED", "SEALED"]),
  reason: z.string().trim().min(20).max(500),
  idempotencyKey: z.string().trim().min(1).max(180),
});
const paramsSchema = z.object({ periodId: z.uuid() });

export const POST = createMutationRoute({
  schema: bodySchema,
  paramsSchema,
  operation: "period transition",
  rateAction: "period",
  maximumBytes: 16_000,
  successStatus: 200,
  sameOriginMessage: "The period request could not be verified.",
  unauthorizedMessage: "An authorized organization period is required.",
  invalidParamsMessage: "An authorized organization period is required.",
  invalidParamsStatus: 403,
  rateLimitMessage: "Too many period-control requests. Try again later.",
  invalidMessage: "Period transition fields are invalid.",
  failureMessage:
    "The period could not be changed. Refresh it, resolve unposted journals, verify your role, and complete MFA for reopen or seal.",
  auditReason: (body) => body.reason,
  authorize: (body, principal) =>
    (body.toState === "OPEN" || body.toState === "SEALED") &&
      !hasRecentStepUp(principal)
      ? {
          error: "A current MFA step-up is required to reopen or seal a period.",
          status: 403,
        }
      : undefined,
  invoke: (body, context, params) => transitionFiscalPeriod({
    context,
    periodId: params.periodId,
    expectedVersion: body.expectedVersion,
    toState: body.toState,
    idempotencyKey: body.idempotencyKey,
  }),
});
