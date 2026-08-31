import { NextResponse, type NextRequest } from "next/server";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import { queryDatabase } from "@/db/transaction";
import { emailDeliveryReadiness } from "@/modules/identity/auth-store";
import { assertAccountAuthenticationConfigured } from "@/modules/identity/email-provider";
import { assertSignupChallengeConfigured } from "@/modules/identity/signup-challenge";
import {
  assertJournalTypeRegistryDatabase,
  type JournalTypeDatabaseDefinition,
} from "@/modules/ledger/journal-type-registry-contract";
import { loadIdentitySecret } from "@/security/identity-secret";
import { loadOrganizationRootKek } from "@/security/root-secret";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const internalHealthHeader = "x-business-finlynq-internal-health";

// Caddy removes this non-secret marker from every public request. It is
// accepted only on the app's loopback/private-network listener; forwarding
// headers never participate in the decision.
async function get(request: NextRequest) {
  const requestId = requestIdFor(request);
  const includeDetails = request.headers.get(internalHealthHeader) === "1";
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
    await assertJournalTypeRegistryDatabase((text) =>
      queryDatabase<JournalTypeDatabaseDefinition>(text),
    );
    const revision = process.env.BUSINESS_FINLYNQ_IMAGE_REVISION?.trim();
    if (!includeDetails) return NextResponse.json({ status: "ready" }, { headers });
    return NextResponse.json({
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
    }, { headers });
  } catch (error) {
    logRouteFailure("health-readiness", requestId, error);
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers });
  }
}

export const GET = observeRouteHandler("health-readiness", get);
