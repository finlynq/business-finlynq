import { describe, expect, it } from "vitest";
import { filingProgress, filingRetrySeconds, FILING_MAX_ATTEMPTS, FILING_QUEUE_STALL_MS, safeFilingReason } from "@/modules/document-storage/filing-policy";
const now = Date.parse("2026-11-11T21:00:00Z");
const pending = { status: "READY_TO_FILE", completion_hash: "saved", filing_attempt_count: 0, filing_queued_at: new Date(now) };
describe("durable document filing progress", () => {
  it("does not call queued or expired work running", () => {
    expect(filingProgress(pending, now)?.state).toBe("QUEUED");
    expect(filingProgress({ ...pending, filing_token: "abandoned", filing_lease_until: new Date(now - 1) }, now)?.state).toBe("STALLED");
    expect(filingProgress({ ...pending, filing_queued_at: new Date(now - FILING_QUEUE_STALL_MS) }, now)?.state).toBe("STALLED");
  });
  it("reports an active claim, stage, progress and bounded retry wait", () => {
    expect(filingProgress({ ...pending, filing_token: "active", filing_attempt_count: 2, filing_stage: "MOVING", filing_heartbeat_at: new Date(now), filing_lease_until: new Date(now + 1000) }, now)).toMatchObject({ state: "RUNNING", stage: "MOVING", attemptCount: 2, lastProgressAt: null, lastHeartbeatAt: new Date(now).toISOString() });
    expect(filingProgress({ ...pending, filing_heartbeat_at: new Date(now) }, now, new Date(now - 1000).toISOString())).toMatchObject({ lastProgressAt: new Date(now - 1000).toISOString(), lastHeartbeatAt: new Date(now).toISOString() });
    expect(filingProgress({ ...pending, filing_error_code: "STORAGE_THROTTLED", filing_next_retry_at: new Date(now + 120000) }, now)).toMatchObject({ state: "RETRY_WAIT", nextRetryAt: new Date(now + 120000).toISOString() });
  });
  it("preserves terminal outcomes and exposes exhaustion without stale running claims", () => {
    expect(filingProgress({ ...pending, status: "FILED" }, now)?.state).toBe("FILED");
    expect(filingProgress({ ...pending, status: "FILING_FAILED" }, now)?.state).toBe("FAILED");
    expect(filingProgress({ ...pending, filing_attempt_count: FILING_MAX_ATTEMPTS }, now)).toMatchObject({ state: "FAILED", errorCode: "STORAGE_FILING_EXHAUSTED" });
    expect(filingProgress({ status: "PENDING" }, now)).toBeNull();
  });
  it("uses bounded exponential backoff and honors provider Retry-After", () => {
    expect([1,2,6].map(n=>filingRetrySeconds(n))).toEqual([60,120,900]);
    expect(filingRetrySeconds(1,300)).toBe(300);
    expect(filingRetrySeconds(6,100000)).toBe(3600);
    expect(safeFilingReason("STORAGE_PRIVATE_PROVIDER_MESSAGE")).not.toContain("PRIVATE_PROVIDER_MESSAGE");
  });
});
