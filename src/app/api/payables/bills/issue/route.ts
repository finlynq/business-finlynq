import { createSubledgerMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { issueBusinessDocument } from "@/modules/subledger/ar-ap-service";
import { issueBusinessDocumentSchema } from "@/modules/subledger/document-model";

export const POST = createSubledgerMutationRoute({
  schema: issueBusinessDocumentSchema,
  expectedKind: "SUPPLIER_BILL",
  operation: "payables.bill.issue",
  rateAction: "post",
  maximumBytes: 16_000,
  invalidMessage: "Supplier bill issue fields are invalid.",
  failureMessage:
    "The supplier bill could not be issued. Verify its current draft version, approved tax setup, open period, and posting role.",
  invoke: (body, context) => issueBusinessDocument({ context, ...body }),
});
