import { recordRequestObservation, recordRouteFailure } from "@/observability/runtime-metrics";
import { safeFxRateUnavailableDetails } from "@/modules/fx/error-transport";

export type RouteFailureOperation =
  | "account-login"
  | "account-signup-acceptance"
  | "account-signup-request"
  | "banking-mutation"
  | "demo-login"
  | "demo-step-up"
  | "entity-context-selection"
  | "health-readiness"
  | "invitation-acceptance"
  | "mfa-enrollment-confirmation"
  | "mfa-step-up"
  | "metrics-readiness"
  | "mcp-settings"
  | "optional-mfa-activation"
  | "organization-administration"
  | "password-reset-confirmation"
  | "password-reset-escalation"
  | "password-reset-request"
  | "recovery-approval"
  | "session-mfa-enrollment-confirmation"
  | "session-mfa-enrollment-start"
  | "session-revocation"
  | "subledger-mutation";

export type ObservedRouteOperation = RouteFailureOperation
  | "accounting-mutation"
  | "service-liveness"
  | "document-evidence-download"
  | "document-storage"
  | "document-storage-callback";

type RouteErrorType = "Error" | "RangeError" | "SyntaxError" | "TypeError" | "Unknown";
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

function routeErrorType(error: unknown): RouteErrorType {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof Error) return "Error";
  return "Unknown";
}

/**
 * Route logs contain correlation fields and explicitly reviewed fixed-cardinality
 * codes only. Never add the exception, message, stack, request body, identity,
 * token, OTP, or plaintext fields.
 */
export function logRouteFailure(
  operation: RouteFailureOperation,
  requestId: string,
  error: unknown,
): void {
  recordRouteFailure();
  const fxFailure = safeFxRateUnavailableDetails(error);
  console.error(JSON.stringify({
    event: "route.failure",
    operation,
    requestId: requestIdPattern.test(requestId) ? requestId : "invalid-request-id",
    errorType: routeErrorType(error),
    ...(fxFailure ? { errorCode: fxFailure.code } : {}),
    ...(fxFailure?.providerFailureCode
      ? { providerFailureCode: fxFailure.providerFailureCode }
      : {}),
  }));
}

/**
 * Access telemetry is a fixed-cardinality, content-free event. Caddy remains
 * the canonical all-request access log; this event covers observed application
 * handlers and feeds the in-process Prometheus counters.
 */
export function logRouteAccess(
  operation: ObservedRouteOperation,
  requestId: string,
  method: string,
  status: number,
  durationMilliseconds: number,
): void {
  const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
  const safeDuration = Number.isFinite(durationMilliseconds) && durationMilliseconds >= 0
    ? Math.min(Math.round(durationMilliseconds), 3_600_000)
    : 0;
  recordRequestObservation(safeStatus, safeDuration);
  if (process.env.NODE_ENV !== "test" || process.env.BUSINESS_FINLYNQ_TEST_ACCESS_LOGS === "true") {
    console.info(JSON.stringify({
      event: "route.access",
      operation,
      requestId: requestIdPattern.test(requestId) ? requestId : "invalid-request-id",
      method: allowedMethods.has(method) ? method : "OTHER",
      status: safeStatus,
      durationMs: safeDuration,
    }));
  }
}
