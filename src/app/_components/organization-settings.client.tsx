"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  OrganizationAdministrationDto,
  OrganizationMemberDto,
} from "@/modules/identity/organization-administration";

type Feedback = Readonly<{ kind: "error" | "success"; message: string }> | null;

async function responseMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof payload?.error === "string" ? payload.error : "The organization change could not be completed.";
}

export function OrganizationSettings({ workspace }: { workspace: OrganizationAdministrationDto }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [otp, setOtp] = useState("");
  const [stepUpComplete, setStepUpComplete] = useState(!workspace.requiresMfaStepUp);
  const [displayName, setDisplayName] = useState(workspace.displayName);
  const [settingsReason, setSettingsReason] = useState("Update organization profile");
  const [trustedBrowserEnabled, setTrustedBrowserEnabled] = useState(workspace.trustedBrowserPolicy.enabled);
  const [trustedBrowserDurationDays, setTrustedBrowserDurationDays] = useState(workspace.trustedBrowserPolicy.durationDays);
  const [trustedBrowserReason, setTrustedBrowserReason] = useState("Update trusted-browser policy");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState(workspace.assignableRoles[0]?.id ?? "");
  const [inviteReason, setInviteReason] = useState("Add a business team member");
  const [memberReason, setMemberReason] = useState("Update member access");
  const [selectedRoles, setSelectedRoles] = useState<Record<string, string>>({});
  const activeCount = useMemo(
    () => workspace.members.filter((member) => member.status === "ACTIVE").length,
    [workspace.members],
  );

  async function ensureStepUp(): Promise<boolean> {
    if (workspace.isDemo || stepUpComplete) return true;
    if (!/^\d{6}$/.test(otp)) {
      setFeedback({ kind: "error", message: "Enter the current six-digit authenticator code." });
      return false;
    }
    const response = await fetch("/api/auth/mfa/step-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ otp }),
    });
    if (!response.ok) {
      setFeedback({ kind: "error", message: await responseMessage(response) });
      return false;
    }
    setStepUpComplete(true);
    setOtp("");
    return true;
  }

  async function mutate(key: string, url: string, method: "POST" | "PATCH", body: unknown, success: string) {
    setBusy(key);
    setFeedback(null);
    try {
      if (!(await ensureStepUp())) return;
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        if (response.status === 428) setStepUpComplete(false);
        throw new Error(await responseMessage(response));
      }
      setFeedback({ kind: "success", message: success });
      router.refresh();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "The organization change could not be completed.",
      });
    } finally {
      setBusy(null);
    }
  }

  function updateMember(member: OrganizationMemberDto, action: "SUSPEND" | "REACTIVATE" | "REVOKE_SESSIONS") {
    return mutate(
      `${action}-${member.membershipId}`,
      `/api/organization/members/${member.membershipId}`,
      "PATCH",
      {
        action,
        ...(action === "REVOKE_SESSIONS" ? {} : { expectedVersion: member.version }),
        reason: memberReason,
      },
      action === "SUSPEND"
        ? `${member.displayName} was suspended and signed out.`
        : action === "REACTIVATE"
          ? `${member.displayName} can access the organization again.`
          : `${member.displayName}'s active sessions were revoked.`,
    );
  }

  return (
    <div className="settings-layout">
      {feedback && (
        <div
          className={`validation-message ${feedback.kind === "error" ? "validation-error" : "validation-success"}`}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </div>
      )}

      {!workspace.isDemo && !stepUpComplete && (
        <section className="panel form-panel settings-step-up" aria-labelledby="settings-step-up-title">
          <div className="panel-heading">
            <span className="eyebrow">Security check</span>
            <h2 id="settings-step-up-title">Verify before changing access</h2>
            <p>Organization profile and member changes require a fresh authenticator check. Reads remain available.</p>
          </div>
          <label className="full-field">
            <span>Six-digit authenticator code</span>
            <input
              value={otp}
              onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
            />
          </label>
          <p className="form-footnote">Need to add or restart an authenticator? <Link href="/app/account#mfa-enrollment">Open Account &amp; security</Link>.</p>
        </section>
      )}

      <section className="panel form-panel" aria-labelledby="organization-profile-title">
        <div className="panel-heading">
          <span className="eyebrow">Organization</span>
          <h2 id="organization-profile-title">Business profile</h2>
          <p>The legal-entity, ledger, currency, and tax configurations remain managed in their dedicated modules.</p>
        </div>
        <form
          className="close-form"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate("settings", "/api/organization/settings", "PATCH", {
              displayName,
              expectedVersion: workspace.settingsVersion,
              reason: settingsReason,
            }, "Organization profile updated.");
          }}
        >
          <div className="form-grid settings-profile-grid">
            <label><span>Organization name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={160} disabled={!workspace.permissions.canManageSettings} /></label>
            <label><span>Audit reason</span><input value={settingsReason} onChange={(event) => setSettingsReason(event.target.value)} minLength={8} maxLength={500} disabled={!workspace.permissions.canManageSettings} /></label>
          </div>
          <div className="form-actions">
            <button className="primary-button" type="submit" disabled={!workspace.permissions.canManageSettings || busy !== null || displayName.trim() === workspace.displayName}>
              {busy === "settings" ? "Saving…" : "Save business profile"}
            </button>
          </div>
        </form>
      </section>

      <section className="panel form-panel" aria-labelledby="trusted-browser-policy-title">
        <div className="panel-heading">
          <span className="eyebrow">Sign-in security</span>
          <h2 id="trusted-browser-policy-title">Trusted-browser MFA policy</h2>
          <p>When enabled, a user may opt in after a successful password and authenticator login. Their password is still required on later logins, and sensitive actions still require fresh MFA.</p>
        </div>
        <form
          className="close-form"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate("trusted-browser-policy", "/api/organization/settings/trusted-browsers", "PATCH", {
              enabled: trustedBrowserEnabled,
              durationDays: trustedBrowserDurationDays,
              expectedVersion: workspace.settingsVersion,
              reason: trustedBrowserReason,
            }, "Trusted-browser policy updated. Existing trusted-browser grants were revoked for this policy change.");
          }}
        >
          <div className="form-grid settings-profile-grid">
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={trustedBrowserEnabled}
                onChange={(event) => setTrustedBrowserEnabled(event.target.checked)}
                disabled={workspace.isDemo || !workspace.permissions.canManageSettings}
              />
              <span><strong>Allow users to trust a private browser</strong><br />The option remains off unless each user selects it during MFA.</span>
            </label>
            <label>
              <span>Trust duration</span>
              <select
                value={trustedBrowserDurationDays}
                onChange={(event) => setTrustedBrowserDurationDays(Number(event.target.value) as 7 | 30 | 90)}
                disabled={workspace.isDemo || !workspace.permissions.canManageSettings}
              >
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
              </select>
            </label>
            <label><span>Audit reason</span><input value={trustedBrowserReason} onChange={(event) => setTrustedBrowserReason(event.target.value)} minLength={8} maxLength={500} disabled={workspace.isDemo || !workspace.permissions.canManageSettings} /></label>
          </div>
          <p className="form-footnote">Clearing cookies or using private browsing requires MFA again. Password or authenticator changes, account recovery, logout-all, administrator access changes, and policy disablement revoke applicable trust.</p>
          <div className="form-actions">
            <button
              className="primary-button"
              type="submit"
              disabled={workspace.isDemo || !workspace.permissions.canManageSettings || busy !== null || (
                trustedBrowserEnabled === workspace.trustedBrowserPolicy.enabled &&
                trustedBrowserDurationDays === workspace.trustedBrowserPolicy.durationDays
              )}
            >
              {busy === "trusted-browser-policy" ? "Saving…" : "Save trusted-browser policy"}
            </button>
          </div>
        </form>
      </section>

      {workspace.permissions.canManageMembers && (
        <section className="panel form-panel" aria-labelledby="invite-member-title">
          <div className="panel-heading">
            <span className="eyebrow">Controlled onboarding</span>
            <h2 id="invite-member-title">Invite a team member</h2>
            <p>{workspace.isDemo
              ? "The shared demo creates a synthetic local invitation visible to every visitor. No email is sent and the nightly reset removes it."
              : "The invitation is encrypted, expires after 72 hours, and stays within this organization."}</p>
          </div>
          <form
            className="close-form"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate("invite", "/api/organization/invitations", "POST", {
                email: inviteEmail,
                displayName: inviteName,
                roleId: inviteRole,
                reason: inviteReason,
              }, workspace.isDemo ? "Synthetic shared-demo invitation created." : "Invitation queued for secure delivery.");
            }}
          >
            <div className="form-grid form-grid-three">
              <label><span>{workspace.isDemo ? "Synthetic email label" : "Email address"}</span><input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} autoComplete="off" maxLength={254} required /></label>
              <label><span>Display name</span><input value={inviteName} onChange={(event) => setInviteName(event.target.value)} maxLength={160} required /></label>
              <label><span>Fixed role</span><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)} required>{workspace.assignableRoles.map((role) => <option key={role.id} value={role.id}>{role.displayName}</option>)}</select></label>
            </div>
            <label className="full-field"><span>Audit reason</span><input value={inviteReason} onChange={(event) => setInviteReason(event.target.value)} minLength={8} maxLength={500} required /></label>
            <p className="form-footnote">One email can belong to one organization in this version. Existing identities are rejected without revealing where they are registered.</p>
            <div className="form-actions"><button className="primary-button" type="submit" disabled={busy !== null || !inviteRole}>{busy === "invite" ? "Creating…" : workspace.isDemo ? "Create synthetic invitation" : "Send invitation"}</button></div>
          </form>
        </section>
      )}

      <section className="panel member-access-panel" aria-labelledby="member-access-title">
        <div className="panel-heading settings-member-heading">
          <div><span className="eyebrow">Access administration</span><h2 id="member-access-title">Members & fixed roles</h2><p>{activeCount} active member{activeCount === 1 ? "" : "s"}. Role and status changes revoke the affected member&apos;s current sessions.</p></div>
          {workspace.permissions.canManageMembers && <label><span>Audit reason for member actions</span><input value={memberReason} onChange={(event) => setMemberReason(event.target.value)} minLength={8} maxLength={500} /></label>}
        </div>
        {!workspace.permissions.canReadMembers ? (
          <p className="panel-note">Your role can read organization settings but cannot view the member directory.</p>
        ) : (
          <div className="table-scroll" tabIndex={0} aria-label="Organization members">
            <table>
              <thead><tr><th>Member</th><th>Status</th><th>Fixed role</th><th>Sessions</th><th>Access actions</th></tr></thead>
              <tbody>{workspace.members.map((member) => {
                const selectedRole = selectedRoles[member.membershipId] ?? member.role.id;
                const pending = member.status === "PENDING" && member.invitation;
                const cancelled = member.status === "CANCELLED" && member.invitation;
                const terminal = member.status === "SUPERSEDED";
                return (
                  <tr key={member.membershipId}>
                    <td><strong>{member.displayName}{member.isSelf ? " (you)" : ""}</strong><small>{member.email}</small></td>
                    <td><span className={`status-pill ${member.status === "ACTIVE" ? "status-success" : member.status === "PENDING" ? "status-warning" : "status-neutral"}`}>{member.status}</span>{pending && <small>Expires {new Date(pending.expiresAt).toLocaleDateString()}</small>}{member.status === "SUPERSEDED" && <small>Replaced by verified owner signup</small>}</td>
                    <td>
                      <select
                        aria-label={`Role for ${member.displayName}`}
                        value={selectedRole}
                        onChange={(event) => setSelectedRoles((current) => ({ ...current, [member.membershipId]: event.target.value }))}
                        disabled={!workspace.permissions.canManageRoles || member.isSelf || terminal || busy !== null}
                      >{workspace.assignableRoles.map((role) => <option key={role.id} value={role.id}>{role.displayName}</option>)}</select>
                      {workspace.permissions.canManageRoles && !member.isSelf && !terminal && selectedRole !== member.role.id && (
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          disabled={busy !== null || memberReason.trim().length < 8}
                          onClick={() => void mutate(`role-${member.membershipId}`, `/api/organization/members/${member.membershipId}`, "PATCH", {
                            action: "ASSIGN_ROLE",
                            roleId: selectedRole,
                            expectedVersion: member.version,
                            reason: memberReason,
                          }, `${member.displayName}'s role was updated.`)}
                        >Apply role</button>
                      )}
                    </td>
                    <td><strong>{member.activeSessionCount}</strong><small>{member.lastActiveAt ? `Last active ${new Date(member.lastActiveAt).toLocaleDateString()}` : "No recent session"}</small></td>
                    <td><div className="member-action-list">
                      {pending && workspace.permissions.canManageMembers && <>
                        <button type="button" className="secondary-button compact-button" disabled={busy !== null} onClick={() => void mutate(`resend-${pending.id}`, `/api/organization/invitations/${pending.id}/resend`, "POST", { expectedVersion: pending.version, reason: memberReason }, workspace.isDemo ? "Synthetic invitation expiry refreshed." : "Invitation was reissued; the previous link no longer works.")}>Resend</button>
                        <button type="button" className="text-danger-button" disabled={busy !== null} onClick={() => void mutate(`cancel-${pending.id}`, `/api/organization/invitations/${pending.id}/cancel`, "POST", { expectedVersion: pending.version, reason: memberReason }, "Invitation cancelled.")}>Cancel</button>
                        {workspace.isDemo && <button type="button" className="secondary-button compact-button" disabled={busy !== null} onClick={() => void updateMember(member, "REACTIVATE")}>Activate locally</button>}
                      </>}
                      {cancelled && workspace.permissions.canManageMembers && (
                        <button type="button" className="secondary-button compact-button" disabled={busy !== null} onClick={() => void mutate(`reinvite-${cancelled.id}`, `/api/organization/invitations/${cancelled.id}/resend`, "POST", { expectedVersion: cancelled.version, reason: memberReason }, workspace.isDemo ? "Synthetic invitation recreated." : "A new invitation was queued; every previous link remains invalid.")}>Reinvite</button>
                      )}
                      {workspace.permissions.canManageMembers && !member.isSelf && member.status === "ACTIVE" && <button type="button" className="text-danger-button" disabled={busy !== null} onClick={() => void updateMember(member, "SUSPEND")}>Suspend</button>}
                      {workspace.permissions.canManageMembers && !member.isSelf && member.status === "SUSPENDED" && <button type="button" className="secondary-button compact-button" disabled={busy !== null} onClick={() => void updateMember(member, "REACTIVATE")}>Reactivate</button>}
                      {workspace.permissions.canManageMembers && !member.isSelf && member.activeSessionCount > 0 && <button type="button" className="secondary-button compact-button" disabled={busy !== null} onClick={() => void updateMember(member, "REVOKE_SESSIONS")}>Revoke sessions</button>}
                      {member.isSelf && <small>Use another owner or organization admin for changes to your access.</small>}
                    </div></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        <p className="panel-note">The final active owner and final active recovery administrator cannot be removed or suspended. Membership records are retained; application administration does not delete identities.</p>
      </section>
    </div>
  );
}
