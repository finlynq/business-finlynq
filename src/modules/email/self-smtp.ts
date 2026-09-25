import { z } from "zod";
import { emailAddressSchema, inboundProviderMessageSchema, type InboundProviderMessage } from "./model";

export const MAX_RELAY_BODY_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

export class RelayPayloadError extends Error {
  constructor(readonly status: 400 | 413 = 400) { super("Invalid inbound relay payload"); }
}

const mailbox = z.object({ name: z.string().max(1000).nullable(), address: emailAddressSchema }).strict();
const relayPayloadSchema = z.object({
  message_id: z.string().trim().min(1).max(500),
  smtp_message_id: z.string().max(1000).nullable(),
  from: mailbox,
  to: z.array(mailbox).max(100),
  recipient: emailAddressSchema,
  subject: z.string().max(1000),
  text: z.string().max(1_000_000).nullable(),
  html: z.string().max(2_000_000).nullable(),
  received_at: z.iso.datetime({ offset: true }),
  attachments: z.array(z.object({
    filename: z.string().trim().min(1).max(180),
    content_type: z.string().trim().min(1).max(200),
    size: z.number().int().min(1).max(MAX_MESSAGE_BYTES),
    content_base64: z.string().max(4 * Math.ceil(MAX_MESSAGE_BYTES / 3)),
  }).strict()).max(20),
}).strict();

/** Bound the stream itself, including requests without a Content-Length. */
export async function readRelayBody(request: Request): Promise<Buffer> {
  if (Number(request.headers.get("content-length")) > MAX_RELAY_BODY_BYTES) {
    await request.body?.cancel();
    throw new RelayPayloadError(413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RelayPayloadError();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_RELAY_BODY_BYTES) throw new RelayPayloadError(413);
      chunks.push(Buffer.from(result.value));
    }
    if (length < 2) throw new RelayPayloadError();
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel().catch(() => undefined);
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** No API credentials, downloads, or callbacks to Mailpit/Resend. */
export function parseRelayMessage(rawBody: Buffer): InboundProviderMessage {
  const attachments: InboundProviderMessage["attachments"] = [];
  try {
    const payload = relayPayloadSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)));
    let bytes = Buffer.byteLength(payload.text ?? "") + Buffer.byteLength(payload.html ?? "");
    for (const [index, attachment] of payload.attachments.entries()) {
      bytes += attachment.size;
      if (bytes > MAX_MESSAGE_BYTES) throw new RelayPayloadError(413);
      // Buffer's decoder is permissive. Require canonical, padded base64 and
      // an exact byte count so no malformed or partial content is acknowledged.
      const content = Buffer.from(attachment.content_base64, "base64");
      if (content.length !== attachment.size || content.toString("base64") !== attachment.content_base64) {
        content.fill(0);
        throw new RelayPayloadError();
      }
      attachments.push({ id: String(index), filename: attachment.filename,
        mimeType: attachment.content_type, declaredSize: attachment.size, content });
    }
    return inboundProviderMessageSchema.parse({
      provider: "SELF_SMTP",
      // Use Mailpit's stable ID, never SMTP's sender-controlled Message-ID or
      // the changing retry timestamp/signature, for BOTH deduplication keys.
      eventId: payload.message_id, messageId: payload.message_id,
      from: payload.from.address,
      // Route only the selected recipient (also handles Bcc/envelope-only mail).
      // Untrusted To headers must not fan out across tenants.
      to: [payload.recipient], cc: [],
      subject: payload.subject, text: payload.text ?? undefined, html: payload.html ?? undefined,
      receivedAt: payload.received_at,
      // Relay authenticity is not proof of sender SPF/DKIM/DMARC.
      senderAuth: { spf: "UNKNOWN", dkim: "UNKNOWN", dmarc: "UNKNOWN" },
      attachments,
    });
  } catch (error) {
    for (const attachment of attachments) attachment.content?.fill(0);
    if (error instanceof RelayPayloadError) throw error;
    throw new RelayPayloadError();
  }
}
