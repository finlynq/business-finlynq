import { createTaxMutationRoute } from "@/app/api/_shared/tax-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import {
  createTaxFiling,
  createTaxFilingSchema,
} from "@/modules/tax/filing-service";

export const POST = createTaxMutationRoute({
  schema: createTaxFilingSchema,
  operation: "tax-filing-create",
  reportFailure: (requestId, error) => logRouteFailure("tax-filing-create", requestId, error),
  invoke: (body, principal, requestId) => createTaxFiling({
    ...body,
    principal,
    requestId,
  }),
});
