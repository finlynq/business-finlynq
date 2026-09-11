import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { oidcSignupEnabled } from "@/modules/identity/oidc";
import { loadSignupChallengePublicConfiguration } from "@/modules/identity/signup-challenge";
import { SignupForm } from "../_components/signup-form.client";
import { AuthShell } from "../_components/auth-shell";
import styles from "../auth.module.css";

export const metadata: Metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

const microsoftErrors: Record<string, string> = {
  disabled: "Microsoft account signup is not enabled on this environment.",
  expired: "The Microsoft verification expired. Start again.",
  rejected: "Microsoft could not verify the account. Start again.",
  "rate-limited": "Too many Microsoft signup attempts. Wait a minute and try again.",
  unavailable: "Microsoft account signup is temporarily unavailable.",
};

export default async function SignupPage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<{ method?: string; microsoftError?: string }>;
} = {}) {
  const params = await searchParams;
  const localEnabled = process.env.ACCOUNT_SIGNUP_ENABLED === "true" &&
    process.env.ACCOUNT_LOGIN_ENABLED === "true";
  const microsoftEnabled = oidcSignupEnabled();
  let challenge: ReturnType<typeof loadSignupChallengePublicConfiguration> | null = null;
  if (localEnabled) {
    try { challenge = loadSignupChallengePublicConfiguration(); } catch { challenge = null; }
  }
  const localReady = localEnabled && challenge !== null;
  const microsoftVerified = microsoftEnabled && params.method === "microsoft";
  const ready = localReady || microsoftEnabled;
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <AuthShell
      eyebrow="Business account"
      title={microsoftVerified ? "Finish your Microsoft signup" : ready ? "Create your workspace" : "Secure account signup is being enabled"}
      description={microsoftVerified
        ? "Microsoft verified your identity. Add your business and contact details; the contact email is verified separately and is never used to silently link another account."
        : ready
          ? "Choose Microsoft without a Business Finlynq password, or create independent email and password credentials. Both paths create a private organization workspace."
        : "Account creation is temporarily closed while verified email delivery and signup abuse protection are completed. This page will not create or retain an account request yet."}
    >
      {microsoftVerified
        ? <SignupForm
            authentication="microsoft"
            challenge={{ enabled: false, siteKey: null, action: "organization-signup" }}
          />
        : ready
          ? <>
              {params.microsoftError && <div className={styles.alert} role="alert">{microsoftErrors[params.microsoftError] ?? microsoftErrors.rejected}</div>}
              {microsoftEnabled && (
                <Link className={styles.demoButton} href="/api/auth/oidc/start?intent=signup" prefetch={false}>
                  Sign up with Microsoft <span aria-hidden="true">→</span>
                </Link>
              )}
              {microsoftEnabled && localReady && <div className={styles.divider}><span>or use email</span></div>}
              {localReady && challenge && <SignupForm authentication="password" challenge={challenge} nonce={nonce} />}
              <Link className={styles.afterFormLink} href="/login">Sign in to an existing account</Link>
            </>
        : <>
            <Link className={styles.demoButton} href="/try-demo?next=/app" prefetch={false}>Open the live demo <span aria-hidden="true">→</span></Link>
            <Link className={styles.afterFormLink} href="/login">Sign in to an existing account</Link>
            <p className={styles.securityNote}>Signup will open only after email verification, optional authenticator enrollment, delivery monitoring, and hostname-bound bot protection are ready.</p>
          </>}
    </AuthShell>
  );
}
