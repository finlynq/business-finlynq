const DEMO_TRANSACTION_AUTH_METHODS = new Set([
  "demo-link",
  "demo-link+mfa",
]);

export function isDemoTransactionAuthMethod(authMethod: string): boolean {
  return DEMO_TRANSACTION_AUTH_METHODS.has(authMethod.toLowerCase());
}
