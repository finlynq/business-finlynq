export const FILING_MAX_ATTEMPTS = 6;
export const FILING_CONCURRENCY = 3;
export const FILING_LEASE_SECONDS = 150;
export const FILING_DEADLINE_MS = 120_000;
export const FILING_POLL_MS = 15_000;
export const FILING_HEARTBEAT_STALE_MS = 45_000;
export const FILING_QUEUE_STALL_MS = 10 * 60_000;

export type FilingFields = {
  status: string; completion_hash?: string | null;
  filing_attempt_count?: number; filing_token?: string | null;
  filing_actor_id?: string | null; filing_queued_at?: Date | null;
  filing_started_at?: Date | null; filing_heartbeat_at?: Date | null;
  filing_lease_until?: Date | null; filing_next_retry_at?: Date | null;
  filing_error_code?: string | null; filing_stage?: string | null;
};
const safeReasons: Readonly<Record<string, string>> = {
  STORAGE_RECONNECT: "Reconnect the original cloud account, then retry filing.",
  STORAGE_DISCONNECTED: "Reconnect the original storage connection, then retry filing.",
  STORAGE_CONTENT_CHANGED: "The document changed after completion. Restore the original before retrying.",
  STORAGE_FILE_MOVED: "Restore the original document to its expected Inbox or Archive location before retrying.",
  STORAGE_FOLDER_BOUNDARY: "Restore the connection's original folder boundaries before retrying.",
  STORAGE_MISSING: "The original cloud file or folder is unavailable. Restore it before retrying.",
  STORAGE_THROTTLED: "The provider is throttling requests. Filing will retry after the displayed delay.",
  STORAGE_FILING_TIMEOUT: "The filing attempt reached its time limit and will be retried.",
  STORAGE_FILING_EXHAUSTED: "Automatic filing retries are exhausted. Check the connection and retry explicitly.",
  STORAGE_FILING_LEASE_LOST: "This attempt lost its claim. The saved filing work remains recoverable.",
};
export function safeFilingReason(code: string | null | undefined) {
  return code ? safeReasons[code] ?? "Cloud filing could not complete. Check the connection and retry filing." : null;
}
const iso = (date?: Date | null) => date?.toISOString() ?? null;
export function filingProgress(row: FilingFields, now = Date.now(), lastProgressAt?: string) {
  if (!row.completion_hash || !["READY_TO_FILE", "FILING_FAILED", "FILED"].includes(row.status)) return null;
  const attempts = row.filing_attempt_count ?? 0;
  const active = Boolean(row.filing_token && row.filing_lease_until && row.filing_lease_until.getTime() > now
    && row.filing_heartbeat_at && now - row.filing_heartbeat_at.getTime() < FILING_HEARTBEAT_STALE_MS);
  const state = row.status === "FILED" ? "FILED"
    : active ? "RUNNING"
      : row.status === "FILING_FAILED" || attempts >= FILING_MAX_ATTEMPTS ? "FAILED"
        : row.filing_next_retry_at && row.filing_next_retry_at.getTime() > now ? "RETRY_WAIT"
          : row.filing_token || (row.filing_queued_at && now - row.filing_queued_at.getTime() >= FILING_QUEUE_STALL_MS) ? "STALLED"
            : "QUEUED";
  const errorCode = attempts >= FILING_MAX_ATTEMPTS && state === "FAILED"
    ? "STORAGE_FILING_EXHAUSTED" : row.filing_error_code ?? (state === "STALLED" ? "STORAGE_FILING_STALLED" : null);
  return { state, stage: state === "RUNNING" ? row.filing_stage ?? "STARTING" : null, attemptCount: attempts,
    maxAttempts: FILING_MAX_ATTEMPTS, queuedAt: iso(row.filing_queued_at), startedAt: iso(row.filing_started_at),
    lastProgressAt: lastProgressAt ?? iso(row.filing_started_at), lastHeartbeatAt: iso(row.filing_heartbeat_at), leaseUntil: iso(row.filing_lease_until), nextRetryAt: iso(row.filing_next_retry_at),
    errorCode, lastErrorCode: row.filing_error_code ?? null, reason: state === "STALLED" ? "Filing has no live worker claim or has not started within ten minutes. Retry from an authorized session to recover it."
      : state === "RETRY_WAIT" ? "The previous filing attempt did not complete. Filing will retry automatically at the displayed time." : safeFilingReason(errorCode) };
}
export function filingRetrySeconds(attempt: number, providerSeconds?: number) {
  const provider = Number.isFinite(providerSeconds) ? Math.max(0, Math.min(3600, Math.ceil(providerSeconds!))) : 0;
  return Math.max(Math.min(60 * 2 ** Math.max(0, attempt - 1), 900), provider);
}
