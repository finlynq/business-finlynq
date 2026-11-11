import { createSubledgerMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { voidIssuedBusinessDocument } from "@/modules/subledger/ar-ap-service";
import { voidBusinessDocumentSchema } from "@/modules/subledger/document-model";

export const POST = createSubledgerMutationRoute({
  schema: voidBusinessDocumentSchema,
  expectedKind: "SUPPLIER_CREDIT_NOTE",
  operation: "payables.credit-note.void",
  rateAction: "reverse",
  maximumBytes: 16_000,
  invalidMessage: "Supplier credit note void fields are invalid.",
  failureMessage:
    "The supplier credit note could not be voided. Verify its posted version, allocations, target period, and void/posting roles.",
  auditReason: (body) => body.reason,
  invoke: (body, context) => voidIssuedBusinessDocument({ context, ...body }),
});
