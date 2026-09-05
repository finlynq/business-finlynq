import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { attachEvidenceSchema, detachEvidenceSchema } from "@/modules/subledger/evidence-model";
import { attachDocumentEvidence, detachDocumentEvidence } from "@/modules/subledger/evidence-service";

export const POST = createMutationRoute({
  schema: attachEvidenceSchema, operation: "document-evidence.attach", rateAction: "create", maximumBytes: 8192,
  invalidMessage: "Evidence link fields are invalid.",
  failureMessage: "Evidence could not be linked. Check the current draft version, asset, and your module role.",
  auditReason: (body) => body.reason,
  invoke: (body, context) => attachDocumentEvidence({ context, ...body }),
});
export const DELETE = createMutationRoute({
  schema: detachEvidenceSchema, operation: "document-evidence.detach", rateAction: "create", maximumBytes: 8192,
  invalidMessage: "Evidence link fields are invalid.",
  failureMessage: "Evidence could not be detached. Only the exact current draft version can be changed.",
  auditReason: (body) => body.reason,
  invoke: (body, context) => detachDocumentEvidence({ context, ...body }),
});
