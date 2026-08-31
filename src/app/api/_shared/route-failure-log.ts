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

type RouteErrorType = "Error" | "RangeError" | "SyntaxError" | "TypeError" | "Unknown";
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function routeErrorType(error: unknown): RouteErrorType {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof Error) return "Error";
  return "Unknown";
}

/**
 * Route logs are deliberately correlation-only. Never add the exception,
 * message, stack, request body, identity, token, OTP, or plaintext fields.
 */
export function logRouteFailure(
  operation: RouteFailureOperation,
  requestId: string,
  error: unknown,
): void {
  console.error("Business Finlynq route failure", {
    operation,
    requestId: requestIdPattern.test(requestId) ? requestId : "invalid-request-id",
    errorType: routeErrorType(error),
  });
}
