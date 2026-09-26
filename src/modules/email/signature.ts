import { createHmac, timingSafeEqual } from "node:crypto";

export class WebhookSignatureError extends Error {
  readonly code = "EMAIL_WEBHOOK_SIGNATURE_INVALID";
}

/** Personal Finlynq's DevManager push protocol: HMAC(timestamp + '.' + raw body). */
export function verifyRelayWebhook(input: Readonly<{
  rawBody: Buffer;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  now?: number;
}>): void {
  if (!input.timestamp || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.timestamp)
      || !input.signature || !/^sha256=[a-f0-9]{64}$/.test(input.signature)) {
    throw new WebhookSignatureError("Required relay signature headers are invalid");
  }
  const timestamp = Date.parse(input.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs((input.now ?? Date.now()) - timestamp) > 300_000) {
    throw new WebhookSignatureError("Relay timestamp is outside the accepted window");
  }
  const expected = createHmac("sha256", input.secret).update(`${input.timestamp}.`).update(input.rawBody).digest();
  const candidate = Buffer.from(input.signature.slice("sha256=".length), "hex");
  if (!timingSafeEqual(candidate, expected)) {
    throw new WebhookSignatureError("Relay signature does not match the raw request body");
  }
}

function decodedSecret(secret: string): Buffer {
  const value = secret.trim();
  if (!value.startsWith("whsec_")) throw new WebhookSignatureError("Webhook signing secret is invalid");
  const decoded = Buffer.from(value.slice("whsec_".length), "base64");
  if (decoded.length < 16) throw new WebhookSignatureError("Webhook signing secret is invalid");
  return decoded;
}

export function verifySvixWebhook(input: Readonly<{
  rawBody: string;
  messageId: string | null;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  now?: number;
  toleranceSeconds?: number;
}>): void {
  if (!input.messageId || !input.timestamp || !input.signature) {
    throw new WebhookSignatureError("Required webhook signature headers are missing");
  }
  const seconds = Number(input.timestamp);
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(seconds) || Math.abs(nowSeconds - seconds) > tolerance) {
    throw new WebhookSignatureError("Webhook signature timestamp is outside the accepted window");
  }
  const secret = decodedSecret(input.secret);
  try {
    const expected = createHmac("sha256", secret)
      .update(`${input.messageId}.${input.timestamp}.${input.rawBody}`, "utf8")
      .digest();
    const signatures = input.signature.split(/\s+/).flatMap((part) => {
      const [version, encoded] = part.split(",", 2);
      if (version !== "v1" || !encoded) return [];
      try { return [Buffer.from(encoded, "base64")]; } catch { return []; }
    });
    if (!signatures.some((candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected))) {
      throw new WebhookSignatureError("Webhook signature does not match the raw request body");
    }
  } finally {
    secret.fill(0);
  }
}
