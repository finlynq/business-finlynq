import type { Metadata } from "next";
import Link from "next/link";
import { loadSignupChallengePublicConfiguration } from "@/modules/identity/signup-challenge";
import { SignupForm } from "../_components/signup-form.client";
import { AuthShell } from "../_components/auth-shell";
import styles from "../auth.module.css";

export const metadata: Metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default function SignupPage() {
  const enabled = process.env.ACCOUNT_SIGNUP_ENABLED === "true" &&
    process.env.ACCOUNT_LOGIN_ENABLED === "true";
  let challenge: ReturnType<typeof loadSignupChallengePublicConfiguration> | null = null;
  if (enabled) {
    try { challenge = loadSignupChallengePublicConfiguration(); } catch { challenge = null; }
  }
  const ready = enabled && challenge !== null;
  return (
    <AuthShell
      eyebrow="Business account"
      title={ready ? "Create your workspace" : "New accounts are not available"}
      description={ready
        ? "Start a full private US or Canadian organization. Verify your email and authenticator before the owner account becomes active."
        : "Self-service account creation is currently closed. You can still explore the isolated public demo."}
    >
      {ready && challenge
        ? <SignupForm challenge={challenge} />
        : <Link className={styles.afterFormLink} href="/login">Return to sign in</Link>}
    </AuthShell>
  );
}
