import { createSubledgerMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { voidSettlementAndReverseAllocations } from "@/modules/subledger/ar-ap-service";
import { voidSettlementSchema } from "@/modules/subledger/document-model";

export const POST = createSubledgerMutationRoute({
  schema: voidSettlementSchema,
  expectedKind: "SUPPLIER_PAYMENT",
  operation: "payables.payment.void",
  rateAction: "reverse",
  maximumBytes: 16_000,
  invalidMessage: "Supplier payment void fields are invalid.",
  failureMessage:
    "The supplier payment could not be voided. Verify its posted version, reversal period, and payables void/posting roles.",
  auditReason: (body) => body.reason,
  invoke: (body, context) => voidSettlementAndReverseAllocations({ context, ...body }),
});
