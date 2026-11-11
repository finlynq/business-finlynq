import { createSubledgerMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import {
  createBusinessDocumentDraft,
  editBusinessDocumentDraft,
} from "@/modules/subledger/ar-ap-service";
import {
  createBusinessDocumentSchema,
  editBusinessDocumentSchema,
} from "@/modules/subledger/document-model";

export const POST = createSubledgerMutationRoute({
  schema: createBusinessDocumentSchema,
  expectedKind: "SUPPLIER_CREDIT_NOTE",
  operation: "payables.credit-note.create-draft",
  rateAction: "create",
  maximumBytes: 256_000,
  invalidMessage: "Supplier credit note fields are invalid.",
  failureMessage:
    "The supplier credit note draft could not be saved. Verify the party, accounting setup, dates, tax and FX facts, and your payables role.",
  invoke: (body, context) => createBusinessDocumentDraft({ context, ...body }),
});

export const PATCH = createSubledgerMutationRoute({
  schema: editBusinessDocumentSchema,
  expectedKind: "SUPPLIER_CREDIT_NOTE",
  operation: "payables.credit-note.edit-draft",
  rateAction: "create",
  maximumBytes: 256_000,
  successStatus: 200,
  invalidMessage: "Supplier credit note fields or expected version are invalid.",
  failureMessage:
    "The supplier credit note draft could not be updated. Verify its current draft version, accounting setup, dates, tax and FX facts, and your payables role.",
  invoke: (body, context) => editBusinessDocumentDraft({ context, ...body }),
});
