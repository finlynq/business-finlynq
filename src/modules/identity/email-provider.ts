import { readFileSync } from "node:fs";

type EmailEnvironment = Readonly<Record<string, string | undefined>>;

export type EmailMessage = Readonly<{
  recipient: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}>;

export type EmailDeliveryConfiguration = Readonly<{
  provider: "resend";
  apiKey: string;
  from: string;
  replyTo?: string;
}>;

export type EmailDeliveryMetadata = Omit<EmailDeliveryConfiguration, "apiKey">;

export class EmailDeliveryError extends Error {
  constructor(public readonly code: string, public readonly retryable: boolean) {
    super(`Email delivery failed (${code})`);
    this.name = "EmailDeliveryError";
  }
}

function secretValue(environment: EmailEnvironment, readTextFile: (path: string) => string): string {
  const file = environment.RESEND_API_KEY_FILE?.trim();
  const inline = environment.RESEND_API_KEY?.trim();
  if (file && inline) throw new Error("Configure only one Resend API-key source");
  if (file) {
    let value: string;
    try { value = readTextFile(file).trim(); } catch (error) {
      throw new Error("Unable to load the Resend API-key file", { cause: error });
    }
    if (!value || value.includes("\n") || value.includes("\r")) throw new Error("The Resend API-key file must contain one value");
    return value;
  }
  if (inline && environment.NODE_ENV !== "production") return inline;
  if (inline) throw new Error("Production requires RESEND_API_KEY_FILE");
  throw new Error("RESEND_API_KEY_FILE is required");
}

function validateMailboxHeader(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 320 || /[\r\n]/.test(trimmed) || !trimmed.includes("@")) {
    throw new Error(`${name} must be a valid single-line mailbox`);
  }
  return trimmed;
}

export function loadEmailDeliveryConfiguration(
  environment: EmailEnvironment = process.env,
  readTextFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): EmailDeliveryConfiguration {
  const metadata = loadEmailDeliveryMetadata(environment);
  return { ...metadata, apiKey: secretValue(environment, readTextFile) };
}

export function loadEmailDeliveryMetadata(
  environment: EmailEnvironment = process.env,
): EmailDeliveryMetadata {
  if (environment.AUTH_EMAIL_DELIVERY_ENABLED !== "true") throw new Error("Authentication email delivery is disabled");
  if (environment.AUTH_EMAIL_PROVIDER?.trim().toLowerCase() !== "resend") {
    throw new Error("AUTH_EMAIL_PROVIDER must explicitly select resend");
  }
  const from = validateMailboxHeader(environment.AUTH_EMAIL_FROM ?? "", "AUTH_EMAIL_FROM");
  const replyToValue = environment.AUTH_EMAIL_REPLY_TO?.trim();
  return {
    provider: "resend",
    from,
    ...(replyToValue ? { replyTo: validateMailboxHeader(replyToValue, "AUTH_EMAIL_REPLY_TO") } : {}),
  };
}

export function assertAccountAuthenticationConfigured(environment: EmailEnvironment = process.env): void {
  if (environment.ACCOUNT_LOGIN_ENABLED !== "true") throw new Error("Real-account authentication is disabled");
  loadEmailDeliveryMetadata(environment);
}

export async function sendEmail(
  message: EmailMessage,
  configuration = loadEmailDeliveryConfiguration(),
  fetchImplementation: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImplementation("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": message.idempotencyKey,
      },
      body: JSON.stringify({
        from: configuration.from,
        to: [message.recipient],
        ...(configuration.replyTo ? { reply_to: configuration.replyTo } : {}),
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new EmailDeliveryError("provider_timeout", true);
    throw new EmailDeliveryError("provider_network", true);
  }

  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
    throw new EmailDeliveryError(`provider_http_${response.status}`, retryable);
  }
  const body = await response.json().catch(() => null) as { id?: unknown } | null;
  if (!body || typeof body.id !== "string" || body.id.length === 0 || body.id.length > 200) {
    throw new EmailDeliveryError("provider_invalid_response", true);
  }
  return body.id;
}
