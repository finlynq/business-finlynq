const RETRYABLE_DATABASE_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "53300", // too_many_connections
  "55P03", // lock_not_available / lock timeout
  "57014", // query_canceled / statement timeout
  "57P03", // cannot_connect_now
]);

export function isRetryableDatabaseError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && typeof (error as { code?: unknown }).code === "string"
    && RETRYABLE_DATABASE_CODES.has((error as { code: string }).code),
  );
}
