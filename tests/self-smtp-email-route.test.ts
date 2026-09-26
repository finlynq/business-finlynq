import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ingest, secret } = vi.hoisted(() => ({ ingest: vi.fn(), secret: vi.fn() }));
vi.mock("@/modules/email/inbound", () => ({ ingestInboundEmail: ingest }));
vi.mock("@/modules/email/secrets", () => ({ inboundRelaySecret: secret }));
vi.mock("@/observability/request-observability", () => ({ observeRouteHandler: (_: string, handler: unknown) => handler }));
import { POST } from "@/app/api/email/inbound/self-smtp/route";
import { POST as retiredPOST } from "@/app/api/email/inbound/resend/route";

const testSecret = "business-relay-synthetic-test-secret-32";
function request(options: { body?: string; signature?: string; timestamp?: string; messageId?: string; recipient?: string } = {}) {
  const body = options.body ?? JSON.stringify({ message_id: "mailpit-1", smtp_message_id: null,
    from: { name: null, address: "sender@example.test" }, to: [],
    recipient: options.recipient ?? "businessdev-0123456789abcdef0123456789abcdef@mail.finlynq.com",
    subject: "Invoice", text: null, html: null, received_at: new Date().toISOString(), attachments: [] });
  const timestamp = options.timestamp ?? new Date().toISOString();
  return new Request("https://example.test/api/email/inbound/self-smtp", { method: "POST", body,
    headers: { "Content-Type": "application/json", "X-Mail-Timestamp": timestamp,
      "X-Mail-Signature": options.signature ?? `sha256=${createHmac("sha256", testSecret).update(`${timestamp}.${body}`).digest("hex")}`,
      "X-Mail-Message-Id": options.messageId ?? "mailpit-1" } });
}
beforeEach(() => {
  vi.clearAllMocks();
  secret.mockReturnValue(testSecret);
  ingest.mockResolvedValue({ accepted: true, routedRecipients: 1, ignoredRecipients: 0, replays: 0, retryPending: true });
  vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN", "mail.finlynq.com");
  vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX", "businessdev-");
  vi.stubEnv("APP_ORIGIN", "https://dev.business.finlynq.com");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("self-hosted receiving endpoint", () => {
  it.each([
    ["https://dev.business.finlynq.com", "businessdev-"],
    ["https://stage.business.finlynq.com", "businessstage-"],
    ["https://business.finlynq.com", "business-"],
  ])("accepts only its configured alias namespace at %s", async (origin, prefix) => {
    vi.stubEnv("APP_ORIGIN", origin);
    vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX", prefix);
    const recipient = `${prefix}${"a".repeat(32)}@mail.finlynq.com`;
    expect((await POST(request({ recipient }))).status).toBe(200);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ to: [recipient], cc: [] }));
  });

  it("acknowledges only after durable ingestion, including stored retry-pending mail", async () => {
    let complete!: (value: unknown) => void;
    ingest.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    let responded = false;
    const pending = POST(request()).then((response) => { responded = true; return response; });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    expect(responded).toBe(false);
    complete({ retryPending: true });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, retryPending: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("fails closed when unconfigured or storage fails, without leaking content", async () => {
    secret.mockReturnValueOnce(null);
    expect((await POST(request())).status).toBe(503);
    expect(ingest).not.toHaveBeenCalled();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ingest.mockRejectedValueOnce(new Error("private message and credentials"));
    const failed = await POST(request());
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("30");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private message");
  });

  it("rejects tampering, stale signatures, malformed JSON, wrong-domain and mismatched IDs before ingestion", async () => {
    expect((await POST(request({ signature: `sha256=${"0".repeat(64)}` }))).status).toBe(401);
    expect((await POST(request({ timestamp: new Date(Date.now() - 301_000).toISOString() }))).status).toBe(401);
    expect((await POST(request({ body: "{" }))).status).toBe(400);
    expect((await POST(request({ messageId: "different" }))).status).toBe(400);
    vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN", "other-environment.example.test");
    expect((await POST(request())).status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("retires Resend receiving without calling any provider or ingest code", async () => {
    expect((await retiredPOST(request())).status).toBe(410);
    expect(ingest).not.toHaveBeenCalled();
  });

  it.each(["business-", "businessstage-", "import-", "importdev-", "in+"])(
    "rejects the %s namespace even with a valid signature on the shared domain", async (prefix) => {
      expect((await POST(request({ recipient: `${prefix}${"a".repeat(32)}@mail.finlynq.com` }))).status).toBe(400);
      expect(ingest).not.toHaveBeenCalled();
    },
  );

  it.each(["", "business-", "importdev-"])("fails closed with missing/misconfigured prefix %s", async (prefix) => {
    vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX", prefix);
    expect((await POST(request())).status).toBe(503);
    expect(ingest).not.toHaveBeenCalled();
  });
});
