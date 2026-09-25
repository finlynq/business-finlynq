import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RELAY_BODY_BYTES, parseRelayMessage, readRelayBody, RelayPayloadError } from "@/modules/email/self-smtp";
import { verifyRelayWebhook, WebhookSignatureError } from "@/modules/email/signature";
import { emailSecretReadiness, inboundRelaySecret } from "@/modules/email/secrets";
import { emailProviderReadiness } from "@/modules/email/configuration";
import nextConfig from "../next.config";

const secret = "business-relay-synthetic-test-secret-32";
const timestamp = "2026-09-25T00:00:00.000Z";
const recipient = "in+0123456789abcdef0123456789abcdef@inbound.example.test";
const pdf = Buffer.from("%PDF-1.7\nfixture\n%%EOF");
function payload() {
  return { message_id: "mailpit-1", smtp_message_id: "sender-controlled",
    from: { name: "Supplier", address: "supplier@example.test" },
    to: [{ name: null, address: "another-tenant@example.test" }], recipient,
    subject: "Invoice", text: "Attached", html: null, received_at: timestamp,
    attachments: [{ filename: "invoice.pdf", content_type: "application/pdf", size: pdf.length,
      content_base64: pdf.toString("base64") }] };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const sign = (body: Buffer, time = timestamp) => `sha256=${createHmac("sha256", secret).update(`${time}.`).update(body).digest("hex")}`;

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("self-hosted Mailpit relay protocol", () => {
  it("preserves the full signed body through Next's proxy buffer, including one overflow byte", () => {
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(MAX_RELAY_BODY_BYTES + 1);
  });
  it("matches Personal's exact timestamp.body HMAC and rejects modification, stale and future signatures", () => {
    const rawBody = bytes(payload());
    const input = { rawBody, secret, timestamp, signature: sign(rawBody), now: Date.parse(timestamp) };
    expect(() => verifyRelayWebhook(input)).not.toThrow();
    for (const change of [
      { rawBody: Buffer.concat([rawBody, Buffer.from(" ")]) }, { secret: "wrong" },
      { now: input.now + 300_001 }, { now: input.now - 300_001 },
      { timestamp: null }, { timestamp: "not-a-date" }, { timestamp: "1758758400" },
      { signature: null }, { signature: "sha256=abcd" }, { signature: `sha256=${"z".repeat(64)}` },
    ]) expect(() => verifyRelayWebhook({ ...input, ...change })).toThrow(WebhookSignatureError);
  });

  it("uses inline bytes and only the matched recipient, with stable Mailpit IDs and untrusted sender auth", () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const message = parseRelayMessage(bytes(payload()));
    expect(message).toMatchObject({ provider: "SELF_SMTP", eventId: "mailpit-1", messageId: "mailpit-1",
      to: [recipient], cc: [], senderAuth: { spf: "UNKNOWN", dkim: "UNKNOWN", dmarc: "UNKNOWN" } });
    expect(message.attachments[0].content).toEqual(pdf);
    expect(parseRelayMessage(bytes({ ...payload(), smtp_message_id: "changed" })).messageId).toBe("mailpit-1");
    expect(parseRelayMessage(bytes({ ...payload(), to: [] })).to).toEqual([recipient]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed payloads and incomplete/noncanonical attachments", () => {
    for (const raw of [Buffer.from("{"), Buffer.from([0xff]), bytes({}), bytes({ ...payload(), recipient: "bad" }),
      bytes({ ...payload(), attachments: [{ ...payload().attachments[0], size: pdf.length + 1 }] }),
      bytes({ ...payload(), attachments: [{ ...payload().attachments[0], content_base64: `${pdf.toString("base64")}!` }] }),
      bytes({ ...payload(), attachments: Array.from({ length: 21 }, () => payload().attachments[0]) }),
    ]) expect(() => parseRelayMessage(raw)).toThrow(RelayPayloadError);
    const large = Buffer.alloc(6 * 1024 * 1024);
    expect(() => parseRelayMessage(bytes({ ...payload(), attachments: [0, 1].map(() => ({
      filename: "big.pdf", content_type: "application/pdf", size: large.length, content_base64: large.toString("base64"),
    })) }))).toThrow(expect.objectContaining({ status: 413 }));
  });

  it("bounds chunked bodies as well as declared Content-Length", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel });
    const request = new Request("https://example.test", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readRelayBody(request)).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalled();
    await expect(readRelayBody(new Request("https://example.test", { method: "POST", body: "{}",
      headers: { "Content-Length": String(MAX_RELAY_BODY_BYTES + 1) } }))).rejects.toMatchObject({ status: 413 });
    await expect(readRelayBody(new Request("https://example.test", { method: "POST", body: "{}" }))).resolves.toEqual(Buffer.from("{}"));
  });

  it("receiving readiness is independent of missing/broken Resend credentials", () => {
    vi.stubEnv("ACCOUNTING_EMAIL_INBOUND_RELAY_SECRET", secret);
    vi.stubEnv("ACCOUNTING_EMAIL_INBOUND_RELAY_SECRET_FILE", "");
    vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN", "inbound.example.test");
    vi.stubEnv("ACCOUNTING_EMAIL_RESEND_API_KEY", "");
    vi.stubEnv("ACCOUNTING_EMAIL_RESEND_API_KEY_FILE", "/nonexistent/outbound-key");
    expect(emailSecretReadiness()).toMatchObject({ apiKey: false, inboundRelay: true });
    expect(emailProviderReadiness()).toMatchObject({ inbound: true, outbound: false });
    vi.stubEnv("ACCOUNTING_EMAIL_INBOUND_RELAY_SECRET", "short");
    expect(emailProviderReadiness().inbound).toBe(false);
    vi.stubEnv("ACCOUNTING_EMAIL_INBOUND_RELAY_SECRET", `whsec_${"a".repeat(40)}`);
    expect(() => inboundRelaySecret()).toThrow("dedicated secret");
    vi.stubEnv("ACCOUNTING_EMAIL_INBOUND_RELAY_SECRET", secret);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => inboundRelaySecret()).toThrow("Production requires");
  });
});
