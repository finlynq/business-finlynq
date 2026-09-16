import { createTaxMutationRoute } from "@/app/api/_shared/tax-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import {
  saveTaxAccountMappings,
  saveTaxAccountMappingsSchema,
} from "@/modules/tax/filing-service";

export const POST = createTaxMutationRoute({
  schema: saveTaxAccountMappingsSchema,
  operation: "tax-mapping-save",
  reportFailure: (requestId, error) => logRouteFailure("tax-mapping-save", requestId, error),
  invoke: (body, principal, requestId) => saveTaxAccountMappings({
    ...body,
    principal,
    requestId,
  }),
});
