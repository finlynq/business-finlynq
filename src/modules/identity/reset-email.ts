import { configuredAppOrigin } from "./request-security";

export async function sendPasswordResetEmail(recipient: string, token: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.AUTH_EMAIL_FROM?.trim();
  if (!apiKey || !from) throw new Error("Password-reset email delivery is not configured");

  const resetUrl = new URL("/reset-password", configuredAppOrigin());
  const link = `${resetUrl.toString()}#token=${encodeURIComponent(token)}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [recipient],
      subject: "Reset your Business Finlynq password",
      html: `<p>A password reset was requested for your Business Finlynq account.</p><p><a href="${link}">Reset password</a></p><p>This link expires in one hour. If you did not request it, no action is needed.</p>`,
      text: `Reset your Business Finlynq password: ${link}\n\nThis link expires in one hour. If you did not request it, no action is needed.`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Password-reset email provider returned ${response.status}`);
}
