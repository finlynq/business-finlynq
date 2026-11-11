import { createSubledgerMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { voidSettlementAndReverseAllocations } from "@/modules/subledger/ar-ap-service";
import { voidSettlementSchema } from "@/modules/subledger/document-model";
export const POST = createSubledgerMutationRoute({
  schema: voidSettlementSchema, expectedKind: "SUPPLIER_CREDIT_APPLICATION",
  operation: "payables.credit-application.void", rateAction: "reverse", maximumBytes: 16000,
  invalidMessage: "Supplier credit application fields are invalid.",
  failureMessage: "Verify the supplier, credit and bill balances, accounting date, mappings and permissions.",
  auditReason: (body) => body.reason,
  invoke: (body, context) => voidSettlementAndReverseAllocations({ context, ...body }),
});
