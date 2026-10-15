import { createTaxMutationRoute } from "@/app/api/_shared/tax-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { taxWorkpaperControlSchema, commandTaxWorkpaperControl } from "@/modules/tax/workpaper-controls";
export const POST = createTaxMutationRoute({ schema: taxWorkpaperControlSchema, operation: "tax-workpaper-control",
 reportFailure:(requestId,error)=>logRouteFailure("tax-workpaper-control",requestId,error),
 invoke:(body,principal,requestId)=>commandTaxWorkpaperControl({...body,principal,requestId}), });
