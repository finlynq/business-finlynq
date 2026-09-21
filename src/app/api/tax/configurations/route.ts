import { createTaxMutationRoute } from "@/app/api/_shared/tax-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import {
  saveTaxFilingConfiguration,
  saveTaxFilingConfigurationSchema,
} from "@/modules/tax/filing-service";

export const POST = createTaxMutationRoute({
  schema: saveTaxFilingConfigurationSchema,
  operation: "tax-filing-configuration-save",
  reportFailure: (requestId, error) => logRouteFailure("tax-filing-configuration-save", requestId, error),
  invoke: (body, principal, requestId) => saveTaxFilingConfiguration({ ...body, principal, requestId }),
});
