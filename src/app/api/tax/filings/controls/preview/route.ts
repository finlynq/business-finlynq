import { observeRouteHandler } from "@/observability/request-observability";
import { requestIdFor } from "@/observability/request-correlation";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { NextRequest, NextResponse } from "next/server";
import { requestPrincipal } from "@/modules/identity/session";
import { isAuthorizationDeniedError } from "@/modules/identity/authorization-error";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";
import { z } from "zod";
const taxFilingReadinessSchema = z.object({filingId:z.uuid()}).strict();
import { previewTaxWorkpaperControl } from "@/modules/tax/workpaper-controls";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };
async function preview(request: NextRequest) {
  const requestId = requestIdFor(request);
  try {
    const principal = await requestPrincipal(request);
    if (!principal) return NextResponse.json({ error: "Sign in to check workpaper dependencies." }, { status: 401, headers });
    const parsed = taxFilingReadinessSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) return NextResponse.json({ error: "Choose a valid company, template and period." }, { status: 400, headers });
    return NextResponse.json(await previewTaxWorkpaperControl(principal, parsed.data.filingId), { headers });
  } catch (error) {
    const expired = demoSessionLeaseLostResponse(error);
    if (expired) return expired;
    if (!isAuthorizationDeniedError(error)) logRouteFailure("tax-workpaper-control-preview", requestId, error);
    return NextResponse.json({ error: "Workpaper dependencies could not be checked. Reload and try again." },
      { status: isAuthorizationDeniedError(error) ? 403 : 503, headers });
  }
}

export const GET = observeRouteHandler("tax-workpaper-control-preview", preview);
