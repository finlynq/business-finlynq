import type { Metadata } from "next";
import Link from "next/link";
import { CompleteSignupForm } from "../_components/complete-signup-form.client";
import { AuthShell } from "../_components/auth-shell";
import styles from "../auth.module.css";

export const metadata: Metadata = { title: "Activate account" };
export const dynamic = "force-dynamic";

export default function CompleteSignupPage() {
  const enabled = process.env.ACCOUNT_LOGIN_ENABLED === "true";
  return (
    <AuthShell
      eyebrow="Email verified setup"
      title={enabled ? "Secure your owner account" : "Account activation is not enabled"}
      description={enabled
        ? "Create a password, then scan an authenticator QR code for stronger security or continue with password-only sign-in."
        : "Real account activation is disabled on this deployment."}
    >
      {enabled
        ? <CompleteSignupForm />
        : <Link className={styles.afterFormLink} href="/login">Return to sign in</Link>}
    </AuthShell>
  );
}
