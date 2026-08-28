import { NextResponse } from "next/server";
import { queryDatabase } from "@/db/transaction";
import { emailDeliveryReadiness } from "@/modules/identity/auth-store";
import { assertAccountAuthenticationConfigured } from "@/modules/identity/email-provider";
import { assertSignupChallengeConfigured } from "@/modules/identity/signup-challenge";
import { loadIdentitySecret } from "@/security/identity-secret";
import { loadOrganizationRootKek } from "@/security/root-secret";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

export async function GET() {
  try {
    loadIdentitySecret();
    loadOrganizationRootKek();
    const accountAuthentication = process.env.ACCOUNT_LOGIN_ENABLED === "true" ? "ready" : "disabled";
    const accountSignup = process.env.ACCOUNT_SIGNUP_ENABLED === "true" ? "ready" : "disabled";
    const bankFeeds = process.env.BANK_FEEDS_ENABLED === "true" ? "ready" : "disabled";
    if (accountSignup === "ready" && accountAuthentication !== "ready") {
      throw new Error("Self-service signup requires real-account authentication");
    }
    let emailWorker = "disabled";
    if (accountAuthentication === "ready") {
      assertAccountAuthenticationConfigured();
      const delivery = await emailDeliveryReadiness();
      if (!delivery.worker_ready) throw new Error("Authentication email delivery worker is unavailable");
      emailWorker = "ready";
    }
    if (accountSignup === "ready") assertSignupChallengeConfigured();
    const result = await queryDatabase<{ ready: number }>("SELECT 1::integer AS ready");
    if (result.rows[0]?.ready !== 1) throw new Error("Database readiness query returned an unexpected result");
    const revision = process.env.BUSINESS_FINLYNQ_IMAGE_REVISION?.trim();
    return NextResponse.json(
      {
        status: "ready",
        checks: {
          database: "ready",
          organizationKey: "ready",
          identityKey: "ready",
          accountAuthentication,
          accountSignup,
          emailWorker,
          bankFeeds,
        },
        revision: revision && /^[a-f0-9]{7,64}$/i.test(revision) ? revision : "unknown",
      },
      { headers },
    );
  } catch (error) {
    console.error("Business Finlynq readiness check failed", { error });
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers });
  }
}
