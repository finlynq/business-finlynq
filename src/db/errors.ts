/**
 * A demo principal was valid when the request began, but its database lease
 * was revoked before the tenant transaction acquired the lease lock. The
 * message is intentionally generic so PostgreSQL diagnostics never cross the
 * application boundary.
 */
export class DemoSessionLeaseLostError extends Error {
  readonly code = "DEMO_SESSION_LEASE_LOST";

  constructor(options?: ErrorOptions) {
    super("The demo session is no longer active.", options);
    this.name = "DemoSessionLeaseLostError";
  }
}

export function isDemoSessionLeaseLostError(error: unknown): error is DemoSessionLeaseLostError {
  return error instanceof DemoSessionLeaseLostError;
}
