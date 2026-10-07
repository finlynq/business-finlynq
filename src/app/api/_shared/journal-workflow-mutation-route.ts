import { z } from "zod";
import { isAuthorizationDeniedError } from "@/modules/identity/authorization-error";
import { JournalWorkflowError } from "@/modules/ledger/journal-workflow-service";

export const journalWorkflowBodySchema = z.object({
  expectedContentHash: z.string().regex(/^[0-9a-f]{64}$/i),
  reason: z.string().trim().min(10).max(500),
}).strict();

export const journalApprovalBodySchema = journalWorkflowBodySchema.extend({
  expectedApprovalVersion: z.number().int().positive(),
});

export const journalRecoveryBodySchema = journalApprovalBodySchema.extend({
  idempotencyKey: z.uuidv4(),
});

export function journalWorkflowMutationOptions(action: "submit" | "approve" | "withdraw" | "reject" | "post") {
  return {
    paramsSchema: z.object({ journalId: z.uuid() }),
    operation: `journal ${action}`,
    rateAction: action,
    maximumBytes: 16_000,
    successStatus: 200 as const,
    unauthorizedMessage: "A writable organization journal session is required.",
    invalidParamsMessage: "An authorized organization journal is required.",
    invalidParamsStatus: 403 as const,
    invalidMessage: "Provide the reviewed journal version and an audit reason of at least 10 characters.",
    failureMessage: "The journal action could not be completed. Refresh the journal to review its current state and allowed actions.",
    auditReason: (body: { reason: string }) => body.reason,
    domainError: (error: unknown) => {
      if (error instanceof JournalWorkflowError) {
        return { error: error.message, code: error.code,
          status: error.code === "MISSING_PERMISSION" ? 403 as const : 409 as const };
      }
      if (error instanceof Error && "code" in error && (error.code === "STALE_VERSION" || error.code === "STALE_CONTENT_HASH")) {
        return { error: "The journal changed after review. Refresh it and review the current version before continuing.", code: error.code, status: 409 as const };
      }
      if (isAuthorizationDeniedError(error)) {
        return { error: "Your current role cannot perform this journal action.", code: "MISSING_PERMISSION", status: 403 as const };
      }
      return undefined;
    },
  };
}
