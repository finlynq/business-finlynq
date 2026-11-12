import { createSubledgerMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { applySupplierCredit } from "@/modules/subledger/ar-ap-service";
import { applySupplierCreditSchema } from "@/modules/subledger/supplier-credit-application";
export const POST = createSubledgerMutationRoute({
  schema: applySupplierCreditSchema, expectedKind: "SUPPLIER_CREDIT_APPLICATION",
  operation: "payables.credit-application.apply", rateAction: "post", maximumBytes: 16000,
  invalidMessage: "Supplier credit application fields are invalid.",
  failureMessage: "Verify the supplier, credit and bill balances, accounting date, mappings and permissions.",
  invoke: (body, context) => applySupplierCredit({ context, ...body }),
});
