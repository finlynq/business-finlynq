import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentPrincipal } from "@/modules/identity/session";
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

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; demoError?: string; reason?: string }> }) {
  const principal = await currentPrincipal();
  if (principal?.sessionMode === "real") redirect("/app");
  const params = await searchParams;
  const next = safeAppPath(params.next);
  const initialMessage = params.demoError ? demoErrors[params.demoError] : params.reason === "expired" ? "Your session ended. Sign in again to continue." : undefined;
  const accountLoginEnabled = process.env.ACCOUNT_LOGIN_ENABLED === "true";

  return (
    <AuthShell
      eyebrow={accountLoginEnabled ? "Secure workspace" : "Public product preview"}
      title={accountLoginEnabled ? "Welcome back" : "Explore Business Finlynq"}
      description={principal?.sessionMode === "demo" && accountLoginEnabled
        ? "Sign in to switch from the public demo to your private organization. Your daily demo claim remains available until its nightly reset."
        : accountLoginEnabled
          ? "Sign in to your organization’s accounting workspace."
          : "Open the synthetic business directly—no registration or credentials required."}
    >
      <LoginForm next={next} initialMessage={initialMessage} accountLoginEnabled={accountLoginEnabled} />
    </AuthShell>
  );
}
