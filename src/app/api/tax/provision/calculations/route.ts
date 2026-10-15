import { createTaxMutationRoute } from "@/app/api/_shared/tax-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { provisionCalculationSchema, saveProvisionCalculation } from "@/modules/tax/provision-service";
export const POST = createTaxMutationRoute({ schema: provisionCalculationSchema, operation: "tax-provision-command", reportFailure: (requestId, error) => logRouteFailure("tax-provision-command", requestId, error), invoke: (body, principal, requestId) => saveProvisionCalculation({ ...body, principal, requestId }) });
