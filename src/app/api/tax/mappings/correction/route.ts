import { createTaxMutationRoute } from "@/app/api/_shared/tax-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { correctTaxAccountMappings, correctTaxAccountMappingsSchema } from "@/modules/tax/filing-service";

export const POST = createTaxMutationRoute({
  schema: correctTaxAccountMappingsSchema,
  operation: "tax-mapping-correction",
  reportFailure: (requestId, error) => logRouteFailure("tax-mapping-correction", requestId, error),
  invoke: (body, principal, requestId) => correctTaxAccountMappings({ ...body, principal, requestId }),
});
