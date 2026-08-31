import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { loadSignupChallengePublicConfiguration } from "@/modules/identity/signup-challenge";
import { SignupForm } from "../_components/signup-form.client";
import { AuthShell } from "../_components/auth-shell";
import styles from "../auth.module.css";

export const metadata: Metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default async function SignupPage() {
  const enabled = process.env.ACCOUNT_SIGNUP_ENABLED === "true" &&
    process.env.ACCOUNT_LOGIN_ENABLED === "true";
  let challenge: ReturnType<typeof loadSignupChallengePublicConfiguration> | null = null;
  if (enabled) {
    try { challenge = loadSignupChallengePublicConfiguration(); } catch { challenge = null; }
  }
  const ready = enabled && challenge !== null;
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <AuthShell
      eyebrow="Business account"
      title={ready ? "Create your workspace" : "Secure account signup is being enabled"}
      description={ready
        ? "Create an authenticated organization workspace in the hosted preview for any two-letter ISO country. Automated tax packs currently cover Ontario and Washington; other jurisdictions remain in explicit manual review. This preview is not a production system of record."
        : "Account creation is temporarily closed while verified email delivery and signup abuse protection are completed. This page will not create or retain an account request yet."}
    >
      {ready && challenge
        ? <SignupForm challenge={challenge} nonce={nonce} />
        : <>
            <Link className={styles.demoButton} href="/try-demo?next=/app" prefetch={false}>Open the live demo <span aria-hidden="true">→</span></Link>
            <Link className={styles.afterFormLink} href="/login">Sign in to an existing account</Link>
            <p className={styles.securityNote}>Signup will open only after email verification, optional authenticator enrollment, delivery monitoring, and hostname-bound bot protection are ready.</p>
          </>}
    </AuthShell>
  );
}
