import { createSubledgerMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { voidIssuedBusinessDocument } from "@/modules/subledger/ar-ap-service";
import { voidBusinessDocumentSchema } from "@/modules/subledger/document-model";

export const POST = createSubledgerMutationRoute({
  schema: voidBusinessDocumentSchema,
  expectedKind: "SALES_INVOICE",
  operation: "receivables.invoice.void",
  rateAction: "reverse",
  maximumBytes: 16_000,
  invalidMessage: "Sales invoice void fields are invalid.",
  failureMessage:
    "The sales invoice could not be voided. Verify its posted version, allocations, target period, and void/posting roles.",
  auditReason: (body) => body.reason,
  invoke: (body, context) => voidIssuedBusinessDocument({ context, ...body }),
});
