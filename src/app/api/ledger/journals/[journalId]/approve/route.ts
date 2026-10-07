import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { journalApprovalBodySchema, journalWorkflowMutationOptions } from "@/app/api/_shared/journal-workflow-mutation-route";
import { approveSubmittedJournal } from "@/modules/ledger/journal-workflow-service";

export const POST = createMutationRoute({
  ...journalWorkflowMutationOptions("approve"),
  schema: journalApprovalBodySchema,
  invoke: (body, context, params) => approveSubmittedJournal({
    context,
    journalId: params.journalId,
    ...body,
  }),
});
