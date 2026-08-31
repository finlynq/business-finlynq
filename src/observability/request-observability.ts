import { logRouteAccess, type ObservedRouteOperation } from "@/app/api/_shared/route-failure-log";
import { requestIdFor, responseWithRequestId } from "./request-correlation";

export async function observeRoute<T extends Response>(
  request: Request,
  operation: ObservedRouteOperation,
  invoke: (requestId: string) => Promise<T>,
): Promise<T> {
  const requestId = requestIdFor(request);
  const startedAt = performance.now();
  try {
    const response = await invoke(requestId);
    logRouteAccess(operation, requestId, request.method, response.status, performance.now() - startedAt);
    return responseWithRequestId(response, requestId);
  } catch (error) {
    logRouteAccess(operation, requestId, request.method, 500, performance.now() - startedAt);
    throw error;
  }
}

/**
 * Instruments a complete Next.js route-handler export. Every dynamic API
 * handler must either use this adapter or one of the observed mutation
 * factories; this is the coverage contract for the in-process API metrics.
 */
export function observeRouteHandler<
  TRequest extends Request,
  TArguments extends unknown[],
  TResponse extends Response,
>(
  operation: ObservedRouteOperation,
  handler: (request: TRequest, ...args: TArguments) => Promise<TResponse>,
): (request: TRequest, ...args: TArguments) => Promise<TResponse> {
  return (request, ...args) => observeRoute(
    request,
    operation,
    () => handler(request, ...args),
  );
}
