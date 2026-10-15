import { createTaxMutationRoute } from "@/app/api/_shared/tax-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { taxDraftCommandSchema, commandTaxDraft } from "@/modules/tax/draft-service";
export const POST = createTaxMutationRoute({ schema: taxDraftCommandSchema, operation: "tax-draft-command",
 reportFailure:(requestId,error)=>logRouteFailure("tax-draft-command",requestId,error),
 invoke:(body,principal,requestId)=>commandTaxDraft({...body,principal,requestId}), });
