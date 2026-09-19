import { createSubledgerMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { issueBusinessDocument } from "@/modules/subledger/ar-ap-service";
import { issueBusinessDocumentSchema } from "@/modules/subledger/document-model";
import { attemptAutomaticInvoiceDelivery } from "@/modules/email/outbound";

export const POST = createSubledgerMutationRoute({
  schema: issueBusinessDocumentSchema,
  expectedKind: "SALES_INVOICE",
  operation: "receivables.invoice.issue",
  rateAction: "post",
  maximumBytes: 16_000,
  invalidMessage: "Sales invoice issue fields are invalid.",
  failureMessage:
    "The sales invoice could not be issued. Verify its current draft version, approved tax setup, open period, and posting role.",
  invoke: async (body, context) => {
    const issued = await issueBusinessDocument({ context, ...body });
    const automaticDelivery = await attemptAutomaticInvoiceDelivery(context, issued.document);
    return { ...issued, automaticDelivery };
  },
});
