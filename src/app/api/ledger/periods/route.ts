import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  createFiscalPeriods,
  fiscalPeriodCreationSchema,
} from "@/modules/ledger/accounting-configuration";

export async function POST(request: NextRequest) {
  return organizationAdminMutationRoute(request, async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "fiscal-period-create");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, fiscalPeriodCreationSchema);
    if (body.response) return body.response;
    const result = await createFiscalPeriods({
      principal: access.principal,
      requestId,
      sourceSurface: "API",
      ...body.data,
    });
    return NextResponse.json(result, {
      status: !result.accepted ? 409 : result.idempotentReplay || result.summary.created === 0 ? 200 : 201,
      headers: organizationAdminHeaders,
    });
  });
}
