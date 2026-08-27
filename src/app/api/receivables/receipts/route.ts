import { createSubledgerMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { recordCustomerReceiptOrSupplierPayment } from "@/modules/subledger/ar-ap-service";
import { recordSettlementSchema } from "@/modules/subledger/document-model";

export const POST = createSubledgerMutationRoute({
  schema: recordSettlementSchema,
  expectedKind: "CUSTOMER_RECEIPT",
  operation: "receivables.receipt.record",
  rateAction: "post",
  maximumBytes: 128_000,
  invalidMessage: "Customer receipt or allocation fields are invalid.",
  failureMessage:
    "The customer receipt could not be recorded. Verify its open-item allocations, currency and FX facts, account mappings, open period, and receivables role.",
  invoke: (body, context) => recordCustomerReceiptOrSupplierPayment({ context, ...body }),
});
