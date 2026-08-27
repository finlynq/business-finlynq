import { NextResponse } from "next/server";
import { queryDatabase } from "@/db/transaction";
import { emailDeliveryReadiness } from "@/modules/identity/auth-store";
import { assertAccountAuthenticationConfigured } from "@/modules/identity/email-provider";
import { loadIdentitySecret } from "@/security/identity-secret";
import { loadOrganizationRootKek } from "@/security/root-secret";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

export async function GET() {
  try {
    loadIdentitySecret();
    loadOrganizationRootKek();
    const accountAuthentication = process.env.ACCOUNT_LOGIN_ENABLED === "true" ? "ready" : "disabled";
    let emailWorker = "disabled";
    if (accountAuthentication === "ready") {
      assertAccountAuthenticationConfigured();
      const delivery = await emailDeliveryReadiness();
      if (!delivery.worker_ready) throw new Error("Authentication email delivery worker is unavailable");
      emailWorker = "ready";
    }
    const result = await queryDatabase<{ ready: number }>("SELECT 1::integer AS ready");
    if (result.rows[0]?.ready !== 1) throw new Error("Database readiness query returned an unexpected result");
    const revision = process.env.BUSINESS_FINLYNQ_IMAGE_REVISION?.trim();
    return NextResponse.json(
      {
        status: "ready",
        checks: { database: "ready", organizationKey: "ready", identityKey: "ready", accountAuthentication, emailWorker },
        revision: revision && /^[a-f0-9]{7,64}$/i.test(revision) ? revision : "unknown",
      },
      { headers },
    );
  } catch (error) {
    console.error("Business Finlynq readiness check failed", { error });
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers });
  }
}
