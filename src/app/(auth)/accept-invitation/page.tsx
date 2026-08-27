import type { Metadata } from "next";
import Link from "next/link";
import { AcceptInvitationForm } from "../_components/accept-invitation-form.client";
import { AuthShell } from "../_components/auth-shell";
import styles from "../auth.module.css";

export const metadata: Metadata = { title: "Accept invitation" };
export const dynamic = "force-dynamic";

export default function AcceptInvitationPage() {
  const enabled = process.env.ACCOUNT_LOGIN_ENABLED === "true";
  return (
    <AuthShell eyebrow="Account invitation" title={enabled ? "Secure your account" : "Invitations are not enabled in the preview"}
      description={enabled ? "Create a password and enroll a TOTP authenticator. Your account remains disabled until both steps finish." : "Real account invitations are disabled. The public demo opens a disposable synthetic sandbox without registration."}>
      {enabled ? <AcceptInvitationForm /> : <Link className={styles.afterFormLink} href="/login">Return to sign in</Link>}
    </AuthShell>
  );
}
