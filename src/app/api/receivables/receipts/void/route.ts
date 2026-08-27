import { createSubledgerMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { voidSettlementAndReverseAllocations } from "@/modules/subledger/ar-ap-service";
import { voidSettlementSchema } from "@/modules/subledger/document-model";

export const POST = createSubledgerMutationRoute({
  schema: voidSettlementSchema,
  expectedKind: "CUSTOMER_RECEIPT",
  operation: "receivables.receipt.void",
  rateAction: "reverse",
  maximumBytes: 16_000,
  invalidMessage: "Customer receipt void fields are invalid.",
  failureMessage:
    "The customer receipt could not be voided. Verify its posted version, reversal period, and receivables void/posting roles.",
  auditReason: (body) => body.reason,
  invoke: (body, context) => voidSettlementAndReverseAllocations({ context, ...body }),
});
