import { createTaxMutationRoute } from "@/app/api/_shared/tax-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import {
  transitionTaxFilingLifecycle,
  transitionTaxFilingLifecycleSchema,
} from "@/modules/tax/filing-service";

export const POST = createTaxMutationRoute({
  schema: transitionTaxFilingLifecycleSchema,
  operation: "tax-filing-lifecycle-transition",
  reportFailure: (requestId, error) => logRouteFailure("tax-filing-lifecycle-transition", requestId, error),
  invoke: (body, principal, requestId) => transitionTaxFilingLifecycle({ ...body, principal, requestId }),
});
