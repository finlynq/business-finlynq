import { z } from "zod";
import { inboundProviderMessageSchema, normalizeEmailAddress, type InboundProviderMessage } from "./model";

type Fetch = typeof fetch;
const RESEND_API = "https://api.resend.com";

function resendMailbox(value: string): string {
  if (value.includes("\r") || value.includes("\n")) return normalizeEmailAddress(value);
  const display = /^[^<>]*<([^<>]+)>$/.exec(value.trim());
  return normalizeEmailAddress(display?.[1] ?? value);
}

function senderAuthSummary(headers: Record<string, unknown> | undefined) {
  const entries = Object.entries(headers ?? {}).map(([name, value]) => [
    name.toLocaleLowerCase("en-US"), String(value).toLocaleLowerCase("en-US").slice(0, 2000),
  ] as const);
  const values = new Map(entries);
  const result = values.get("authentication-results") ?? "";
  const status = (name: string, directHeader: string) => {
    const direct = values.get(directHeader) ?? "";
    const source = `${direct} ${result}`;
    return new RegExp(`(?:^|[;\\s])${name}=pass(?:[;\\s]|$)`).test(source) || direct === "pass"
      ? "PASS"
      : new RegExp(`(?:^|[;\\s])${name}=(?:fail|softfail|neutral|none|temperror|permerror)(?:[;\\s]|$)`).test(source)
        || /^(?:fail|softfail|neutral|none|temperror|permerror)$/.test(direct)
        ? "NOT_PASS"
        : "UNKNOWN";
  };
  return {
    dkim: status("dkim", "dkim-status"),
    spf: status("spf", "spf-status"),
    dmarc: status("dmarc", "dmarc-status"),
  };
}

const resendWebhookSchema = z.object({
  type: z.literal("email.received"),
  created_at: z.iso.datetime({ offset: true }),
  data: z.object({
    email_id: z.string().min(1).max(500),
    from: z.string().min(3).max(320),
    to: z.array(z.string().min(3).max(320)).min(1).max(100),
    message_id: z.string().min(1).max(500).optional(),
    subject: z.string().max(1000).optional(),
  }).passthrough(),
}).passthrough();

const receivedEmailSchema = z.object({
  id: z.string().min(1).max(500).optional(),
  from: z.string().min(3).max(320),
  to: z.array(z.string().min(3).max(320)).min(1).max(100),
  cc: z.array(z.string().min(3).max(320)).max(100).optional(),
  subject: z.string().max(1000).optional(),
  text: z.string().max(1_000_000).nullable().optional(),
  html: z.string().max(2_000_000).nullable().optional(),
  message_id: z.string().min(1).max(500).optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const attachmentListSchema = z.object({
  has_more: z.boolean().default(false),
  data: z.array(z.object({
    id: z.string().min(1).max(500),
    filename: z.string().min(1).max(180),
    content_type: z.string().min(1).max(200),
    size: z.number().int().min(1).max(25 * 1024 * 1024),
    download_url: z.string().url().max(4096),
  }).passthrough()).max(50),
}).passthrough();

async function boundedBytes(response: Response, maximum: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length") ?? 0) > maximum) {
    await response.body?.cancel();
    throw Object.assign(new Error("Email provider response is too large"), { code: "EMAIL_PROVIDER_RETRYABLE" });
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.length;
      if (length > maximum) {
        throw Object.assign(new Error("Email provider response is too large"), { code: "EMAIL_PROVIDER_RETRYABLE" });
      }
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => undefined);
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function resendJson(request: Promise<Response>, label: string): Promise<unknown> {
  const response = await request;
  if (!response.ok) {
    throw Object.assign(new Error(`${label} is temporarily unavailable`), {
      code: "EMAIL_PROVIDER_RETRYABLE",
      retryAfterSeconds: 5,
    });
  }
  const bytes = await boundedBytes(response, 4 * 1024 * 1024);
  try { return JSON.parse(bytes.toString("utf8")); }
  finally { bytes.fill(0); }
}

function safeAttachmentUrl(value: string, messageId: string, attachmentId: string): URL {
  const url = new URL(value);
  const expectedPath = `/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
  if (url.protocol !== "https:" || url.hostname !== "inbound-cdn.resend.com" || url.port
      || url.username || url.password || url.pathname !== expectedPath || !url.search) {
    throw Object.assign(new Error("Inbound attachment URL failed validation"), { code: "EMAIL_PROVIDER_RETRYABLE" });
  }
  return url;
}

export interface InboundEmailProvider {
  readonly name: "RESEND";
  enrich(rawBody: string, eventId: string): Promise<InboundProviderMessage>;
}

export class ResendInboundProvider implements InboundEmailProvider {
  readonly name = "RESEND" as const;
  constructor(private readonly apiKey: string, private readonly fetcher: Fetch = fetch) {}

  async enrich(rawBody: string, eventId: string): Promise<InboundProviderMessage> {
    const webhook = resendWebhookSchema.parse(JSON.parse(rawBody));
    const id = encodeURIComponent(webhook.data.email_id);
    const headers = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    const [messageValue, attachmentValue] = await Promise.all([
      resendJson(this.fetcher(`${RESEND_API}/emails/receiving/${id}?html_format=cid`, {
        headers, cache: "no-store", signal: AbortSignal.timeout(10_000),
      }), "Inbound email fetch"),
      resendJson(this.fetcher(`${RESEND_API}/emails/receiving/${id}/attachments`, {
        headers, cache: "no-store", signal: AbortSignal.timeout(10_000),
      }), "Inbound attachment fetch"),
    ]);
    const message = receivedEmailSchema.parse(messageValue);
    const attachmentList = attachmentListSchema.parse(attachmentValue);
    const declaredBytes = attachmentList.data.reduce((sum, attachment) => sum + attachment.size, 0);
    const attachmentOverflow = attachmentList.has_more || attachmentList.data.length > 20;
    const downloadAllowed = !attachmentOverflow && declaredBytes <= 25 * 1024 * 1024;
    const attachments = await Promise.all(attachmentList.data.map(async (attachment) => {
      const metadata = {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.content_type,
        declaredSize: attachment.size,
      };
      if (!downloadAllowed || attachment.content_type !== "application/pdf" || attachment.size > 2 * 1024 * 1024) {
        return { ...metadata, content: null };
      }
      const url = safeAttachmentUrl(attachment.download_url, webhook.data.email_id, attachment.id);
      const response = await this.fetcher(url, {
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw Object.assign(new Error("Inbound attachment download is temporarily unavailable"), {
          code: "EMAIL_PROVIDER_RETRYABLE", retryAfterSeconds: 5,
        });
      }
      const content = await boundedBytes(response, 2 * 1024 * 1024);
      if (content.length !== attachment.size) {
        content.fill(0);
        throw Object.assign(new Error("Inbound attachment size changed"), { code: "EMAIL_PROVIDER_RETRYABLE" });
      }
      return { ...metadata, content };
    }));
    return inboundProviderMessageSchema.parse({
      provider: "RESEND",
      eventId,
      messageId: message.message_id ?? webhook.data.message_id ?? webhook.data.email_id,
      from: resendMailbox(message.from),
      to: message.to.map(resendMailbox),
      cc: (message.cc ?? []).map(resendMailbox),
      subject: message.subject ?? webhook.data.subject ?? "",
      text: message.text ?? undefined,
      html: message.html ?? undefined,
      receivedAt: webhook.created_at,
      senderAuth: senderAuthSummary(message.headers),
      attachments,
      attachmentOverflow,
    });
  }
}

export type OutboundEmail = Readonly<{
  from: string;
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  text: string;
  filename: string;
  pdf: Buffer;
  idempotencyKey: string;
}>;

export interface OutboundEmailProvider {
  readonly name: "RESEND";
  send(message: OutboundEmail): Promise<{ providerMessageId: string }>;
}

export class ResendOutboundProvider implements OutboundEmailProvider {
  readonly name = "RESEND" as const;
  constructor(private readonly apiKey: string, private readonly fetcher: Fetch = fetch) {}

  async send(message: OutboundEmail): Promise<{ providerMessageId: string }> {
    const response = await this.fetcher(`${RESEND_API}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": message.idempotencyKey,
      },
      body: JSON.stringify({
        from: message.from,
        to: message.to,
        cc: message.cc ?? [],
        subject: message.subject,
        text: message.text,
        attachments: [{ filename: message.filename, content: message.pdf.toString("base64") }],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw Object.assign(new Error("Invoice delivery provider is temporarily unavailable"), {
        code: "EMAIL_PROVIDER_RETRYABLE",
        retryAfterSeconds: 5,
      });
    }
    const result = z.object({ id: z.string().min(1).max(500) }).parse(await response.json());
    return { providerMessageId: result.id };
  }
}
