import "server-only";
import { readFileSync } from "node:fs";

type SecretName =
  | "ACCOUNTING_EMAIL_RESEND_API_KEY"
  | "ACCOUNTING_EMAIL_INBOUND_WEBHOOK_SECRET"
  | "ACCOUNTING_EMAIL_OUTBOUND_WEBHOOK_SECRET";

function optionalSecret(name: SecretName): string | null {
  const file = process.env[`${name}_FILE`]?.trim();
  const inline = process.env[name]?.trim();
  if (file && inline) throw new Error(`Configure only one ${name} source`);
  if (inline && process.env.NODE_ENV === "production") {
    throw new Error(`Production requires ${name}_FILE`);
  }
  let value = inline ?? "";
  if (file) {
    try {
      value = readFileSync(file, "utf8").trim();
    } catch (error) {
      throw new Error(`Unable to load ${name}_FILE`, { cause: error });
    }
  }
  if (!value) return null;
  if (value.includes("\n") || value.includes("\r") || value.length > 4096) {
    throw new Error(`${name} must contain one bounded value`);
  }
  return value;
}

export function emailResendApiKey(): string | null {
  return optionalSecret("ACCOUNTING_EMAIL_RESEND_API_KEY");
}

export function inboundWebhookSecret(): string | null {
  return optionalSecret("ACCOUNTING_EMAIL_INBOUND_WEBHOOK_SECRET");
}

export function outboundWebhookSecret(): string | null {
  return optionalSecret("ACCOUNTING_EMAIL_OUTBOUND_WEBHOOK_SECRET");
}

export function emailSecretReadiness() {
  try {
    return {
      apiKey: Boolean(emailResendApiKey()),
      inboundWebhook: Boolean(inboundWebhookSecret()),
      outboundWebhook: Boolean(outboundWebhookSecret()),
    };
  } catch {
    return { apiKey: false, inboundWebhook: false, outboundWebhook: false };
  }
}
