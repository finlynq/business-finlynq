import { createTaxMutationRoute } from "@/app/api/_shared/tax-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { saveCloseTemplateSchema, saveCloseTemplate } from "@/modules/close/checklist-service";
export const POST = createTaxMutationRoute({ schema: saveCloseTemplateSchema, operation: "close-checklist-command", domainLabel: "close checklist", reportFailure: (requestId, error) => logRouteFailure("close-checklist-command", requestId, error), invoke: (body, principal, requestId) => saveCloseTemplate({ ...body, principal, requestId }) });
