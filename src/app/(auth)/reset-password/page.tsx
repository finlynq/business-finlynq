import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";
import { ResetPasswordForm } from "../_components/reset-password-form.client";
import styles from "../auth.module.css";

export const metadata: Metadata = { title: "Choose a new password" };
export const dynamic = "force-dynamic";

export default function ResetPasswordPage() {
  const accountLoginEnabled = process.env.ACCOUNT_LOGIN_ENABLED === "true";
  return (
    <AuthShell
      eyebrow="Account recovery"
      title={accountLoginEnabled ? "Choose a new password" : "Recovery is not enabled in the preview"}
      description={accountLoginEnabled ? "Changing your password revokes existing sessions but does not alter your organization’s encrypted accounting records." : "Real account recovery is disabled. The shared public demo opens without an account."}
    >
      {accountLoginEnabled ? <ResetPasswordForm /> : <Link className={styles.afterFormLink} href="/login">Return to sign in</Link>}
    </AuthShell>
  );
}
