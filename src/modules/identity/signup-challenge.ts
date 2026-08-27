import "server-only";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { configuredAppOrigin } from "./request-security";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ACTION = "organization_signup";

type SignupEnvironment = Readonly<Record<string, string | undefined>>;

export type SignupChallengePublicConfiguration = Readonly<{
  enabled: boolean;
  siteKey: string | null;
  action: typeof ACTION;
}>;

type SignupChallengeConfiguration = SignupChallengePublicConfiguration & Readonly<{
  secretKey: string | null;
  expectedHostname: string | null;
}>;

function oneLineSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096 || /[\r\n]/.test(trimmed)) {
    throw new Error(`${label} must contain one value`);
  }
  return trimmed;
}

function loadSecret(
  environment: SignupEnvironment,
  readTextFile: (path: string) => string,
): string {
  const secretFile = environment.TURNSTILE_SECRET_KEY_FILE?.trim();
  const inlineSecret = environment.TURNSTILE_SECRET_KEY?.trim();
  if (secretFile && inlineSecret) throw new Error("Configure only one Turnstile secret-key source");
  if (secretFile) {
    try {
      return oneLineSecret(readTextFile(secretFile), "The Turnstile secret-key file");
    } catch (error) {
      throw new Error("Unable to load the Turnstile secret-key file", { cause: error });
    }
  }
  if (inlineSecret && environment.NODE_ENV !== "production") {
    return oneLineSecret(inlineSecret, "TURNSTILE_SECRET_KEY");
  }
  if (inlineSecret) throw new Error("Production requires TURNSTILE_SECRET_KEY_FILE");
  throw new Error("TURNSTILE_SECRET_KEY_FILE is required when signup challenge protection is enabled");
}

export function loadSignupChallengePublicConfiguration(
  environment: SignupEnvironment = process.env,
): SignupChallengePublicConfiguration {
  const signupEnabled = environment.ACCOUNT_SIGNUP_ENABLED === "true";
  const enabled = environment.SIGNUP_TURNSTILE_ENABLED === "true";
  if (signupEnabled && environment.NODE_ENV === "production" && !enabled) {
    throw new Error("Production account signup requires Turnstile protection");
  }
  if (!enabled) return { enabled: false, siteKey: null, action: ACTION };
  const siteKey = oneLineSecret(environment.SIGNUP_TURNSTILE_SITE_KEY ?? "", "SIGNUP_TURNSTILE_SITE_KEY");
  return { enabled: true, siteKey, action: ACTION };
}

function loadConfiguration(
  environment: SignupEnvironment,
  readTextFile: (path: string) => string,
): SignupChallengeConfiguration {
  const publicConfiguration = loadSignupChallengePublicConfiguration(environment);
  if (!publicConfiguration.enabled) {
    return { ...publicConfiguration, secretKey: null, expectedHostname: null };
  }
  return {
    ...publicConfiguration,
    secretKey: loadSecret(environment, readTextFile),
    expectedHostname: configuredAppOrigin(environment).hostname,
  };
}

export function assertSignupChallengeConfigured(
  environment: SignupEnvironment = process.env,
  readTextFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): void {
  loadConfiguration(environment, readTextFile);
}

export async function verifySignupChallenge(
  input: Readonly<{ token: string; remoteIp?: string }>,
  options: Readonly<{
    environment?: SignupEnvironment;
    readTextFile?: (path: string) => string;
    fetchImplementation?: typeof fetch;
  }> = {},
): Promise<boolean> {
  const environment = options.environment ?? process.env;
  const configuration = loadConfiguration(
    environment,
    options.readTextFile ?? ((path) => readFileSync(path, "utf8")),
  );
  if (!configuration.enabled) return environment.NODE_ENV !== "production";
  if (!input.token || input.token.length > 2048 || !configuration.secretKey) return false;

  const body = new URLSearchParams({
    secret: configuration.secretKey,
    response: input.token,
    idempotency_key: randomUUID(),
  });
  if (input.remoteIp && input.remoteIp !== "unknown") body.set("remoteip", input.remoteIp);

  try {
    const response = await (options.fetchImplementation ?? fetch)(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return false;
    const result = await response.json() as {
      success?: unknown;
      action?: unknown;
      hostname?: unknown;
    };
    return result.success === true && result.action === ACTION &&
      result.hostname === configuration.expectedHostname;
  } catch {
    return false;
  }
}
