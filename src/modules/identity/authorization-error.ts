export class AuthorizationDeniedError extends Error {
  constructor(
    message = "The authenticated principal is not authorized for this operation",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AuthorizationDeniedError";
  }
}

export function isAuthorizationDeniedError(error: unknown): error is AuthorizationDeniedError {
  return error instanceof AuthorizationDeniedError;
}
