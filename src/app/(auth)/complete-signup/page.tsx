import type { Metadata } from "next";
import Link from "next/link";
import { oidcSignupEnabled } from "@/modules/identity/oidc";
import { CompleteSignupForm } from "../_components/complete-signup-form.client";
import { AuthShell } from "../_components/auth-shell";
import styles from "../auth.module.css";

export const metadata: Metadata = { title: "Activate account" };
export const dynamic = "force-dynamic";

const microsoftErrors: Record<string, string> = {
  disabled: "Microsoft account signup is not enabled on this environment.",
  expired: "The Microsoft confirmation expired. Try again.",
  rejected: "Microsoft could not confirm the account. Try again.",
  "rate-limited": "Too many Microsoft confirmation attempts. Wait a minute and try again.",
  unavailable: "Microsoft confirmation is temporarily unavailable.",
};

export default async function CompleteSignupPage({
  searchParams,
}: {
  searchParams: Promise<{ method?: string; identity?: string; microsoftError?: string }>;
}) {
  const params = await searchParams;
  const authentication = params.method === "microsoft" ? "microsoft" : "password";
  const enabled = authentication === "microsoft"
    ? oidcSignupEnabled()
    : process.env.ACCOUNT_LOGIN_ENABLED === "true";
  return (
    <AuthShell
      eyebrow="Email verified setup"
      title={enabled ? authentication === "microsoft" ? "Verify your Microsoft owner account" : "Secure your owner account" : "Account activation is not enabled"}
      description={enabled
        ? authentication === "microsoft"
          ? "Confirm the email link, optionally add an independent Business Finlynq password, and enroll an authenticator for protected owner operations."
          : "Create a password, then scan an authenticator QR code for stronger security or continue with password-only sign-in."
        : "Real account activation is disabled on this deployment."}
    >
      {enabled
        ? <>
            {params.microsoftError && <div className={styles.alert} role="alert">{microsoftErrors[params.microsoftError] ?? microsoftErrors.rejected}</div>}
            <CompleteSignupForm
              authentication={authentication}
              identityConfirmed={authentication === "microsoft" && params.identity === "verified"}
            />
          </>
        : <Link className={styles.afterFormLink} href="/login">Return to sign in</Link>}
    </AuthShell>
  );
}
