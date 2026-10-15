import { createTaxMutationRoute } from "@/app/api/_shared/tax-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { provisionAssumptionCommandSchema, commandProvisionAssumptions } from "@/modules/tax/provision-service";
export const POST = createTaxMutationRoute({ schema: provisionAssumptionCommandSchema, operation: "tax-provision-command", reportFailure: (requestId, error) => logRouteFailure("tax-provision-command", requestId, error), invoke: (body, principal, requestId) => commandProvisionAssumptions({ ...body, principal, requestId }) });
