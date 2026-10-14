import { NextRequest, NextResponse } from "next/server";
import { observeRouteHandler } from "@/observability/request-observability";
import { requestIdFor } from "@/observability/request-correlation";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";
import { isAuthorizationDeniedError } from "@/modules/identity/authorization-error";
import { requestPrincipal } from "@/modules/identity/session";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { previewTaxAccountMappingCorrection, taxMappingCorrectionProposalSchema, TaxFilingError } from "@/modules/tax/filing-service";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };

async function preview(request: NextRequest) {
  const requestId = requestIdFor(request);
  try {
    if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The tax request could not be verified." }, { status: 403, headers });
    const principal = await requestPrincipal(request);
    if (!principal) return NextResponse.json({ error: "Sign in to review this mapping." }, { status: 401, headers });
    const parsed = taxMappingCorrectionProposalSchema.safeParse(await readBoundedJson(request, 32_000));
    if (!parsed.success) return NextResponse.json({ error: "Choose an exact mapping and proposed correction." }, { status: 400, headers });
    return NextResponse.json(await previewTaxAccountMappingCorrection(principal, parsed.data), { headers });
  } catch (error) {
    if (error instanceof MutationBodyError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
    const expired = demoSessionLeaseLostResponse(error);
    if (expired) return expired;
    if (error instanceof TaxFilingError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers });
    if (!isAuthorizationDeniedError(error)) logRouteFailure("tax-mapping-correction-preview", requestId, error);
    return NextResponse.json({ error: "The mapping correction preview could not be loaded." },
      { status: isAuthorizationDeniedError(error) ? 403 : 503, headers });
  }
}

export const POST = observeRouteHandler("tax-mapping-correction-preview", preview);
