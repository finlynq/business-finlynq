import {
  createBusinessDocumentDraft,
  editBusinessDocumentDraft,
} from "@/modules/subledger/ar-ap-service";
import {
  createBusinessDocumentSchema,
  editBusinessDocumentSchema,
} from "@/modules/subledger/document-model";
import { createSubledgerMutationRoute } from "@/app/api/_shared/subledger-mutation-route";

export const POST = createSubledgerMutationRoute({
  schema: createBusinessDocumentSchema,
  expectedKind: "SALES_INVOICE",
  operation: "receivables.invoice.create-draft",
  rateAction: "create",
  maximumBytes: 256_000,
  invalidMessage: "Sales invoice fields are invalid.",
  failureMessage:
    "The sales invoice draft could not be saved. Verify the party, accounting setup, dates, tax and FX facts, and your receivables role.",
  invoke: (body, context) => createBusinessDocumentDraft({ context, ...body }),
});

export const PATCH = createSubledgerMutationRoute({
  schema: editBusinessDocumentSchema,
  expectedKind: "SALES_INVOICE",
  operation: "receivables.invoice.edit-draft",
  rateAction: "create",
  maximumBytes: 256_000,
  successStatus: 200,
  invalidMessage: "Sales invoice fields or expected version are invalid.",
  failureMessage:
    "The sales invoice draft could not be updated. Verify its current draft version, accounting setup, dates, tax and FX facts, and your receivables role.",
  invoke: (body, context) => editBusinessDocumentDraft({ context, ...body }),
});
