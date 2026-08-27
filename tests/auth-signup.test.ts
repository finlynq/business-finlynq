import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderAuthenticationEmail } from "@/modules/identity/auth-email";
import {
  assertSignupChallengeConfigured,
  loadSignupChallengePublicConfiguration,
  verifySignupChallenge,
} from "@/modules/identity/signup-challenge";
import { identityDerivedUuid } from "@/security/identity-secret";

const productionChallengeEnvironment = {
  NODE_ENV: "production",
  ACCOUNT_SIGNUP_ENABLED: "true",
  SIGNUP_TURNSTILE_ENABLED: "true",
  SIGNUP_TURNSTILE_SITE_KEY: "site-key",
  TURNSTILE_SECRET_KEY_FILE: "/run/secrets/turnstile",
  APP_ORIGIN: "https://business.finlynq.com",
} as const;
const signupMigration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0013_self_service_owner_signup.sql"),
  "utf8",
);
const operatorInviteScript = readFileSync(
  join(process.cwd(), "scripts", "invite-account.ts"),
  "utf8",
);

describe("self-service signup security", () => {
  it("derives stable opaque UUIDs without exposing the identity", () => {
    const secret = Buffer.alloc(64, 19);
    const first = identityDerivedUuid("account-user", "email-hash", secret);
    expect(first).toBe(identityDerivedUuid("account-user", "email-hash", secret));
    expect(first).not.toBe(identityDerivedUuid("organization-signup-organization", "email-hash", secret));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toContain("email");
    expect(() => identityDerivedUuid("Invalid Scope", "email-hash", secret)).toThrow(/canonical/);
  });

  it("lets email-verified owner signup supersede only unused invitation state", () => {
    expect(signupMigration).toContain("'business-finlynq|account-user|' || selected_email_hash");
    expect(signupMigration).toContain("existing_user.password_hash <> '!invitation-pending!'");
    expect(signupMigration).toContain("selected_user.email_verified_at IS NOT NULL");
    expect(signupMigration).toContain("to_regclass('public.organization_invitations') IS NOT NULL");
    expect(signupMigration).toContain("purpose IN ('INVITATION', 'MFA_SETUP')");
    expect(signupMigration).toContain("last_error_code = 'SUPERSEDED_BY_SIGNUP'");
    expect(signupMigration).toContain("restarting_enrollment := selected_signup.accepted_at IS NOT NULL");
    expect(signupMigration).toContain("status = 'SUPERSEDED'");
    expect(signupMigration).toContain("membership.organization_id <> selected_token.organization_id");
    expect(signupMigration).toContain("The invitation won the race and already proved the email");
    expect(signupMigration).toContain("IF NOT reusing_invitation_identity");
    expect(signupMigration).toContain("requested_display_name_ciphertext");
  });

  it("keeps operator invitations compatible with the durable invitation registry", () => {
    expect(operatorInviteScript).toContain("This email already has an identity or proof-bearing flow");
    expect(operatorInviteScript).toContain("signup.status IN ('PENDING','EXPIRED')");
    expect(operatorInviteScript).toContain("business-finlynq|account-user|");
    expect(operatorInviteScript).toContain("INSERT INTO auth_one_time_tokens(id,token_hash");
    expect(operatorInviteScript).toContain("INSERT INTO organization_invitations(");
    expect(operatorInviteScript).toContain("invitationTokenId");
  });

  it("fails closed when production signup has no enabled challenge", () => {
    expect(() => loadSignupChallengePublicConfiguration({
      NODE_ENV: "production",
      ACCOUNT_SIGNUP_ENABLED: "true",
      SIGNUP_TURNSTILE_ENABLED: "false",
    })).toThrow(/requires Turnstile/);
    expect(() => assertSignupChallengeConfigured({
      ...productionChallengeEnvironment,
      TURNSTILE_SECRET_KEY_FILE: undefined,
    })).toThrow(/required/);
    expect(() => assertSignupChallengeConfigured({
      ...productionChallengeEnvironment,
      TURNSTILE_SECRET_KEY_FILE: undefined,
      TURNSTILE_SECRET_KEY: "inline-secret",
    })).toThrow(/SECRET_KEY_FILE/);
  });

  it("allows explicitly unchallenged local development but never production", async () => {
    expect(loadSignupChallengePublicConfiguration({
      NODE_ENV: "development",
      ACCOUNT_SIGNUP_ENABLED: "true",
      SIGNUP_TURNSTILE_ENABLED: "false",
    })).toEqual({ enabled: false, siteKey: null, action: "organization_signup" });
    await expect(verifySignupChallenge({ token: "" }, {
      environment: {
        NODE_ENV: "development",
        ACCOUNT_SIGNUP_ENABLED: "true",
        SIGNUP_TURNSTILE_ENABLED: "false",
      },
    })).resolves.toBe(true);
  });

  it("validates Turnstile server-side and binds the action and hostname", async () => {
    let submitted: URLSearchParams | undefined;
    const fetchImplementation = async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
      submitted = init?.body as URLSearchParams;
      return Response.json({ success: true, action: "organization_signup", hostname: "business.finlynq.com" });
    };
    await expect(verifySignupChallenge(
      { token: "challenge-token", remoteIp: "198.51.100.8" },
      {
        environment: productionChallengeEnvironment,
        readTextFile: () => "secret-key\n",
        fetchImplementation: fetchImplementation as typeof fetch,
      },
    )).resolves.toBe(true);
    expect(submitted?.get("secret")).toBe("secret-key");
    expect(submitted?.get("response")).toBe("challenge-token");
    expect(submitted?.get("remoteip")).toBe("198.51.100.8");
    expect(submitted?.get("idempotency_key")).toMatch(/^[0-9a-f-]{36}$/);

    await expect(verifySignupChallenge(
      { token: "challenge-token" },
      {
        environment: productionChallengeEnvironment,
        readTextFile: () => "secret-key",
        fetchImplementation: (async () => Response.json({
          success: true,
          action: "different_action",
          hostname: "business.finlynq.com",
        })) as typeof fetch,
      },
    )).resolves.toBe(false);
  });

  it("puts the organization verification token only in the URL fragment", () => {
    const previousOrigin = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = "https://business.finlynq.com";
    try {
      const rendered = renderAuthenticationEmail({
        templateType: "ORGANIZATION_SIGNUP",
        payload: { token: "one-use-secret" },
        templateData: { organizationName: "Example Books" },
      });
      expect(rendered.text).toContain("/complete-signup#token=one-use-secret");
      expect(rendered.text).not.toContain("?token=");
      expect(rendered.text).toContain("Example Books");
    } finally {
      if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
      else process.env.APP_ORIGIN = previousOrigin;
    }
  });
});
