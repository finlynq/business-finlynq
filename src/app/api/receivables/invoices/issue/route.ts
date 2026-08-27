import { createSubledgerMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { issueBusinessDocument } from "@/modules/subledger/ar-ap-service";
import { issueBusinessDocumentSchema } from "@/modules/subledger/document-model";

export const POST = createSubledgerMutationRoute({
  schema: issueBusinessDocumentSchema,
  expectedKind: "SALES_INVOICE",
  operation: "receivables.invoice.issue",
  rateAction: "post",
  maximumBytes: 16_000,
  invalidMessage: "Sales invoice issue fields are invalid.",
  failureMessage:
    "The sales invoice could not be issued. Verify its current draft version, approved tax setup, open period, and posting role.",
  invoke: (body, context) => issueBusinessDocument({ context, ...body }),
});
