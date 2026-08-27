import { configuredAppOrigin } from "./request-security";

export type AuthenticationEmailTemplate = Readonly<{
  subject: string;
  text: string;
  html: string;
}>;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function actionLink(pathname: string, fragmentKey: string, fragmentValue: string): string {
  const target = new URL(pathname, configuredAppOrigin());
  return `${target.toString()}#${fragmentKey}=${encodeURIComponent(fragmentValue)}`;
}

function wrapHtml(title: string, content: string): string {
  return `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#17233b"><h1 style="font-size:22px">${escapeHtml(title)}</h1>${content}<p style="color:#536078;font-size:13px">Business Finlynq will never ask you to send a password or authenticator code by email.</p></div>`;
}

export function renderAuthenticationEmail(input: {
  templateType: string;
  payload: Record<string, unknown>;
  templateData: Record<string, unknown>;
}): AuthenticationEmailTemplate {
  if (input.templateType === "PASSWORD_RESET") {
    const token = typeof input.payload.token === "string" ? input.payload.token : "";
    if (!token) throw new Error("Password-reset email has no token");
    const link = actionLink("/reset-password", "token", token);
    const policy = input.templateData.policy;
    const delayed = policy === "DELAYED";
    const note = delayed
      ? "For sole-owner protection, this request has a 72-hour security delay. The page will show when the link becomes usable."
      : policy === "CO_OWNER"
        ? "A different recovery administrator must approve this request before the link can be used."
        : policy === "TOTP"
          ? "You will also need a current code from your authenticator."
          : "This one-use link expires in one hour.";
    return {
      subject: "Reset your Business Finlynq password",
      text: `A password reset was requested for your Business Finlynq account.\n\n${link}\n\n${note}\n\nIf you did not request it, contact your organization administrator.`,
      html: wrapHtml("Reset your password", `<p>A password reset was requested for your Business Finlynq account.</p><p><a href="${escapeHtml(link)}">Reset password</a></p><p>${escapeHtml(note)}</p><p>If you did not request it, contact your organization administrator.</p>`),
    };
  }
  if (input.templateType === "INVITATION") {
    const token = typeof input.payload.token === "string" ? input.payload.token : "";
    if (!token) throw new Error("Invitation email has no token");
    const link = actionLink("/accept-invitation", "token", token);
    return {
      subject: "Set up your Business Finlynq account",
      text: `You were invited to Business Finlynq. Set your password and authenticator within 72 hours:\n\n${link}\n\nIf you were not expecting this invitation, ignore it.`,
      html: wrapHtml("Set up your account", `<p>You were invited to Business Finlynq.</p><p><a href="${escapeHtml(link)}">Accept invitation</a></p><p>This one-use invitation expires in 72 hours. You will set a password and enroll an authenticator before the account becomes active.</p>`),
    };
  }
  if (input.templateType === "ORGANIZATION_SIGNUP") {
    const token = typeof input.payload.token === "string" ? input.payload.token : "";
    if (!token) throw new Error("Organization-signup email has no token");
    const link = actionLink("/complete-signup", "token", token);
    const organizationName = typeof input.templateData.organizationName === "string"
      ? input.templateData.organizationName
      : "your business";
    return {
      subject: "Verify your Business Finlynq account",
      text: `Verify your email to create the ${organizationName} workspace:\n\n${link}\n\nThis one-use link expires in 24 hours. You will create a password and enroll an authenticator before the owner account becomes active. If you did not request this, ignore the email.`,
      html: wrapHtml("Verify your business account", `<p>Verify your email to create the <strong>${escapeHtml(organizationName)}</strong> workspace.</p><p><a href="${escapeHtml(link)}">Verify and secure account</a></p><p>This one-use link expires in 24 hours. The business is not provisioned until you use it, and the owner remains disabled until authenticator enrollment succeeds.</p><p>If you did not request this, ignore the email.</p>`),
    };
  }
  if (input.templateType === "RECOVERY_APPROVAL") {
    const requestId = typeof input.templateData.recoveryRequestId === "string" ? input.templateData.recoveryRequestId : "";
    if (!requestId) throw new Error("Recovery approval email has no request id");
    const link = actionLink("/app/security/recovery/approve", "request", requestId);
    return {
      subject: "Recovery approval requested in Business Finlynq",
      text: `Another recovery administrator requested account recovery. Sign in and approve only after verifying the request through a separate channel:\n\n${link}`,
      html: wrapHtml("Recovery approval requested", `<p>Another recovery administrator requested account recovery.</p><p><a href="${escapeHtml(link)}">Review recovery request</a></p><p>Approve only after verifying the person through a separate channel. A fresh authenticator code is required.</p>`),
    };
  }
  const securityMessages: Record<string, { subject: string; message: string }> = {
    SECURITY_PASSWORD_CHANGED: { subject: "Your Business Finlynq password changed", message: "Your password was changed and every existing session was revoked." },
    SECURITY_MFA_ENABLED: { subject: "Authenticator enabled for Business Finlynq", message: "A TOTP authenticator was enabled and your account is now active." },
    SECURITY_MFA_REPLACED: { subject: "Your Business Finlynq authenticator changed", message: "Your previous authenticator was revoked and a replacement authenticator was enabled during protected account recovery." },
    SECURITY_NEW_LOGIN: { subject: "New Business Finlynq sign-in", message: "A new password and authenticator sign-in succeeded for your account." },
    SECURITY_RECOVERY_ESCALATED: { subject: "Business Finlynq recovery protection changed", message: "A password-reset holder reported that the authenticator was unavailable. Co-owner approval or the sole-owner security delay is now required." },
  };
  const selected = securityMessages[input.templateType];
  if (!selected) throw new Error("Unsupported authentication email template");
  return {
    subject: selected.subject,
    text: `${selected.message}\n\nIf this was not you, contact your organization administrator immediately.`,
    html: wrapHtml(selected.subject, `<p>${escapeHtml(selected.message)}</p><p>If this was not you, contact your organization administrator immediately.</p>`),
  };
}
