import { createTaxMutationRoute } from "@/app/api/_shared/tax-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { setTaxFilingCanonical, setTaxFilingCanonicalSchema } from "@/modules/tax/filing-service";

export const POST = createTaxMutationRoute({
  schema: setTaxFilingCanonicalSchema,
  operation: "tax-filing-canonical-select",
  reportFailure: (requestId, error) => logRouteFailure("tax-filing-canonical-select", requestId, error),
  invoke: (body, principal, requestId) => setTaxFilingCanonical({ ...body, principal, requestId }),
});
