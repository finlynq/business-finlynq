import { isRetryableDatabaseError } from "@/db/retryable";

export { isRetryableDatabaseError } from "@/db/retryable";

export const MCP_RETRY_AFTER_SECONDS = 1;

export function isRetryableOperationError(error: unknown): boolean {
  if (isRetryableDatabaseError(error)) return true;
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "MCP_RETRYABLE"
    || (error as { code?: unknown }).code === "STORAGE_RETRYABLE"
    || (error as { code?: unknown }).code === "STORAGE_THROTTLED";
}

export class McpRetryableError extends Error {
  readonly code = "MCP_RETRYABLE";
  readonly retryAfterSeconds = MCP_RETRY_AFTER_SECONDS;

  constructor(message = "A temporary concurrency condition prevented this operation. Retry after 1 second.", options?: ErrorOptions) {
    super(message, options);
    this.name = "McpRetryableError";
  }
}
