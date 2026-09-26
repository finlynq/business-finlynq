import { z } from "zod";

type Fetch = typeof fetch;
const RESEND_API = "https://api.resend.com";

// Resend is outbound-only. Incoming mail uses the self-hosted signed relay.
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
