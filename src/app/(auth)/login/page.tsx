import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentPrincipal } from "@/modules/identity/session";
import { oidcLoginEnabled } from "@/modules/identity/oidc";
import { safeAppPath } from "@/modules/identity/safe-redirect";
import { AuthShell } from "../_components/auth-shell";
import { LoginForm } from "../_components/login-form.client";

export const metadata: Metadata = { title: "Sign in" };

const demoErrors: Record<string, string> = {
  disabled: "The public demo is temporarily disabled.",
  "rate-limited": "The demo has received too many sign-in requests. Please wait a minute and try again.",
  unavailable: "The public demo is temporarily unavailable.",
  "stale-session": "A previous session cookie was cleared because it could no longer be verified. Open the demo again to continue.",
};

const ssoErrors: Record<string, string> = {
  disabled: "Microsoft sign-in is not enabled on this environment.",
  expired: "The Microsoft sign-in request expired. Please try again.",
  rejected: "Microsoft sign-in could not be completed. Please try again.",
  "rate-limited": "Too many Microsoft sign-in attempts. Please wait a minute and try again.",
  unavailable: "Microsoft sign-in is temporarily unavailable.",
  unassigned: "This Microsoft account is not assigned to a Business Finlynq workspace.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; demoError?: string; ssoError?: string; reason?: string }> }) {
  const principal = await currentPrincipal();
  if (principal?.sessionMode === "real") redirect("/app");
  const params = await searchParams;
  const next = safeAppPath(params.next);
  const initialMessage = params.ssoError
    ? ssoErrors[params.ssoError]
    : params.demoError
      ? demoErrors[params.demoError]
      : params.reason === "expired"
        ? "Your session ended. Sign in again to continue."
        : undefined;
  const accountLoginEnabled = process.env.ACCOUNT_LOGIN_ENABLED === "true";
  const ssoLoginEnabled = oidcLoginEnabled();

  return (
    <AuthShell
      eyebrow={accountLoginEnabled ? "Secure workspace" : "Public product preview"}
      title={accountLoginEnabled ? "Welcome back" : "Explore Business Finlynq"}
      description={principal?.sessionMode === "demo" && accountLoginEnabled
        ? "Sign in to switch from the shared public demo to your private organization."
        : accountLoginEnabled
          ? "Sign in to your organization’s accounting workspace."
          : "Open the synthetic business directly—no registration or credentials required."}
    >
      <LoginForm
        next={next}
        initialMessage={initialMessage}
        accountLoginEnabled={accountLoginEnabled}
        ssoLoginEnabled={ssoLoginEnabled}
      />
    </AuthShell>
  );
}
