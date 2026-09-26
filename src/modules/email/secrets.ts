import "server-only";
import { readFileSync } from "node:fs";

type SecretName =
  | "ACCOUNTING_EMAIL_RESEND_API_KEY"
  | "ACCOUNTING_EMAIL_INBOUND_RELAY_SECRET"
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

export function inboundRelaySecret(): string | null {
  const secret = optionalSecret("ACCOUNTING_EMAIL_INBOUND_RELAY_SECRET");
  if (secret && (secret.length < 32 || secret.startsWith("whsec_"))) {
    throw new Error("Inbound relay requires a dedicated secret of at least 32 characters");
  }
  return secret;
}

export function outboundWebhookSecret(): string | null {
  return optionalSecret("ACCOUNTING_EMAIL_OUTBOUND_WEBHOOK_SECRET");
}

export function emailSecretReadiness() {
  const ready = (load: () => string | null) => {
    try { return Boolean(load()); } catch { return false; }
  };
  return {
    apiKey: ready(emailResendApiKey),
    inboundRelay: ready(inboundRelaySecret),
    outboundWebhook: ready(outboundWebhookSecret),
  };
}
