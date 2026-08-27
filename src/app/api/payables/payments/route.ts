import { createSubledgerMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { recordCustomerReceiptOrSupplierPayment } from "@/modules/subledger/ar-ap-service";
import { recordSettlementSchema } from "@/modules/subledger/document-model";

export const POST = createSubledgerMutationRoute({
  schema: recordSettlementSchema,
  expectedKind: "SUPPLIER_PAYMENT",
  operation: "payables.payment.record",
  rateAction: "post",
  maximumBytes: 128_000,
  invalidMessage: "Supplier payment or allocation fields are invalid.",
  failureMessage:
    "The supplier payment could not be recorded. Verify its open-item allocations, currency and FX facts, account mappings, open period, and payables role.",
  invoke: (body, context) => recordCustomerReceiptOrSupplierPayment({ context, ...body }),
});
