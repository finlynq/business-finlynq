import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), retry: vi.fn(), secret: vi.fn() }));
vi.mock("@/db/transaction", () => ({ queryDatabase: mocks.query }));
vi.mock("@/modules/email/inbound", () => ({ retryInboundMessage: mocks.retry }));
vi.mock("@/modules/email/secrets", () => ({ inboundRelaySecret: mocks.secret }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  vi.stubEnv("BUSINESS_WRITES_ENABLED", "true");
  vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN", "mail.finlynq.com");
  vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX", "businessdev-");
  vi.stubEnv("APP_ORIGIN", "https://dev.business.finlynq.com");
  mocks.secret.mockReturnValue("synthetic-retry-test-secret");
  mocks.query.mockResolvedValue({ rows: [{ organization_id: randomUUID(), message_id: randomUUID(),
    actor_id: randomUUID(), provider: "SELF_SMTP" }] });
  mocks.retry.mockResolvedValue({ status: "READY" });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("automatic inbound retry scheduling", () => {
  it("starts once, waits 30 seconds, and never overlaps an unfinished cycle", async () => {
    const { startInboundRetryWorker } = await import("@/modules/email/retry-worker");
    let finish!: (result: { status: string }) => void;
    mocks.retry.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    startInboundRetryWorker(); startInboundRetryWorker();
    await vi.advanceTimersByTimeAsync(29999);
    expect(mocks.query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.query).toHaveBeenCalledWith("SELECT * FROM app.due_inbound_email_retries($1)", [10]);
    expect(mocks.retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    finish({ status: "READY" });
    await vi.advanceTimersByTimeAsync(30000);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("continues after a failed cycle without logging private exception text", async () => {
    const { startInboundRetryWorker } = await import("@/modules/email/retry-worker");
    mocks.query.mockRejectedValueOnce(new Error("private signed URL and token"));
    startInboundRetryWorker();
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private");
  });

  it("does not start when real writes or verified relay configuration are unavailable", async () => {
    const { startInboundRetryWorker } = await import("@/modules/email/retry-worker");
    vi.stubEnv("BUSINESS_WRITES_ENABLED", "false");
    startInboundRetryWorker();
    vi.stubEnv("BUSINESS_WRITES_ENABLED", "true");
    mocks.secret.mockReturnValue(null); startInboundRetryWorker();
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
