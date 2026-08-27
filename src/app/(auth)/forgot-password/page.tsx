import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";
import { ForgotPasswordForm } from "../_components/forgot-password-form.client";
import styles from "../auth.module.css";

export const metadata: Metadata = { title: "Reset password" };
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  const accountLoginEnabled = process.env.ACCOUNT_LOGIN_ENABLED === "true";
  return (
    <AuthShell
      eyebrow="Account recovery"
      title={accountLoginEnabled ? "Reset your password" : "Recovery is not enabled in the preview"}
      description={accountLoginEnabled ? "We’ll send a one-hour reset link if the email belongs to an eligible account." : "Real account recovery is disabled. The public demo opens a disposable synthetic sandbox without an account."}
    >
      {accountLoginEnabled && <ForgotPasswordForm />}
      <Link className={styles.afterFormLink} href="/login">Return to sign in</Link>
    </AuthShell>
  );
}
