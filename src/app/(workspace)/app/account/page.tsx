import Link from "next/link";
import { AccountMfaEnrollment } from "@/app/_components/account-mfa-enrollment.client";
import { DemoNotice, PageHeader, StatusPill } from "@/app/_components/ui";
import { mfaStatusForSession } from "@/modules/identity/auth-store";
import type { SessionPrincipal } from "@/modules/identity/session";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";

function formatSecurityTime(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

function mfaSessionState(principal: SessionPrincipal): Readonly<{
  status: string;
  detail: string;
}> {
  if (principal.mfaVerifiedAt) {
    return {
      status: "VERIFIED",
      detail: `Verified for this session on ${formatSecurityTime(principal.mfaVerifiedAt)} UTC.`,
    };
  }
  if (principal.sessionMode === "demo") {
    return {
      status: "DEMO LINK",
      detail: "The public demo uses an isolated link session and does not represent a personal MFA enrollment.",
    };
  }
  return {
    status: "NOT VERIFIED",
    detail: "This session does not currently carry an MFA verification timestamp.",
  };
}

export default async function AccountPage() {
  const principal = await requireWorkspacePrincipal("/app/account");
  const mfa = mfaSessionState(principal);
  const authenticator = principal.sessionMode === "real"
    ? await mfaStatusForSession(principal.sessionId)
    : null;
  const authenticatorEnabled = Boolean(authenticator?.mfa_required && authenticator.active_factor);
  const authenticatorStatus = principal.sessionMode === "demo"
    ? "DEMO LINK"
    : authenticatorEnabled
      ? "ENABLED"
      : authenticator?.pending_enrollment
        ? "SETUP PENDING"
      : authenticator
        ? "PASSWORD ONLY"
        : "UNAVAILABLE";
  const sessionMode = principal.sessionMode === "demo" ? "Nightly-reset demo" : "Private business account";

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Personal account"
        title="Account & security"
        description="Review the identity, organization role, and authentication state attached to this browser session, and add optional authenticator protection."
      />

      {principal.sessionMode === "demo" && (
        <DemoNotice>
          This is a shared product demonstration, not a personal identity. <Link href="/signup">Create a private business account</Link> to establish verified credentials and optionally add MFA.
        </DemoNotice>
      )}

      <div className="dashboard-columns equal-columns">
        <section className="panel account-overview-panel" aria-labelledby="account-identity-title">
          <div className="panel-heading">
            <div><p className="eyebrow">Identity context</p><h2 id="account-identity-title">Signed-in profile</h2></div>
            <StatusPill status={principal.sessionMode === "demo" ? "DEMO" : "ACTIVE"} />
          </div>
          <dl className="account-detail-list">
            <div><dt>Display name</dt><dd>{principal.displayName}</dd></div>
            <div><dt>Organization</dt><dd>{principal.organizationName}</dd></div>
            <div><dt>Assigned role</dt><dd>{principal.roleLabel}</dd></div>
            <div><dt>Session mode</dt><dd>{sessionMode}</dd></div>
          </dl>
        </section>

        <section className="panel account-overview-panel" aria-labelledby="account-security-title">
          <div className="panel-heading">
            <div><p className="eyebrow">Authentication</p><h2 id="account-security-title">Session security</h2></div>
            <StatusPill status={mfa.status} />
          </div>
          <dl className="account-detail-list">
            <div><dt>Sign-in method</dt><dd>{principal.authMethod.replaceAll("_", " ")}</dd></div>
            <div><dt>Authenticator</dt><dd><StatusPill status={authenticatorStatus} /> {authenticatorEnabled
              ? "TOTP is enabled for sign-in and step-up."
              : principal.sessionMode === "real"
                ? "Password-only sign-in; step-up operations remain unavailable until enrollment."
                : "Not applicable to the shared demo identity."}</dd></div>
            <div><dt>Session MFA</dt><dd>{mfa.detail}</dd></div>
            <div><dt>Session expires</dt><dd><time dateTime={principal.expiresAt.toISOString()}>{formatSecurityTime(principal.expiresAt)} UTC</time></dd></div>
            <div><dt>Recent step-up</dt><dd>{principal.stepUpExpiresAt
              ? <time dateTime={principal.stepUpExpiresAt.toISOString()}>Valid until {formatSecurityTime(principal.stepUpExpiresAt)} UTC</time>
              : "No active privileged-operation step-up"}</dd></div>
          </dl>
        </section>
      </div>

      {principal.sessionMode === "real" && (
        <section className="panel" aria-labelledby="account-authenticator-title">
          <div className="panel-heading">
            <div><p className="eyebrow">Optional protection</p><h2 id="account-authenticator-title">Authenticator enrollment</h2></div>
            <StatusPill status={authenticatorStatus} />
          </div>
          <AccountMfaEnrollment
            enabled={authenticatorEnabled}
            pending={Boolean(authenticator?.pending_enrollment)}
          />
        </section>
      )}

      <section className="panel" aria-labelledby="account-links-title">
        <div className="panel-heading">
          <div><p className="eyebrow">Safe destinations</p><h2 id="account-links-title">Related settings and policies</h2></div>
        </div>
        <div className="panel-actions account-safe-links">
          <Link className="secondary-button" href="/app/settings">Organization settings</Link>
          <Link className="secondary-button" href="/security">Security approach</Link>
          <Link className="secondary-button" href="/privacy">Privacy policy</Link>
          <Link className="secondary-button" href="/terms">Terms of use</Link>
        </div>
        <p className="panel-note">Password replacement, role changes, and recovery approvals use their dedicated protected workflows. Authenticator enrollment is available above for password-only accounts.</p>
      </section>
    </div>
  );
}
