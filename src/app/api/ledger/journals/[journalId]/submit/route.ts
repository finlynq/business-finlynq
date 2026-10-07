import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { journalWorkflowBodySchema, journalWorkflowMutationOptions } from "@/app/api/_shared/journal-workflow-mutation-route";
import { submitJournalForApproval } from "@/modules/ledger/journal-workflow-service";

export const POST = createMutationRoute({
  ...journalWorkflowMutationOptions("submit"),
  schema: journalWorkflowBodySchema,
  invoke: (body, context, params) => submitJournalForApproval({
    context,
    journalId: params.journalId,
    expectedContentHash: body.expectedContentHash,
  }),
});
