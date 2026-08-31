import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  currencyRateConfigurationSchema,
  recordCurrencyRate,
} from "@/modules/ledger/accounting-configuration";

export async function POST(request: NextRequest) {
  return organizationAdminMutationRoute(request, async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "accounting-rate");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, currencyRateConfigurationSchema);
    if (body.response) return body.response;
    const result = await recordCurrencyRate({
      principal: access.principal,
      requestId,
      ...body.data,
    });
    return NextResponse.json(result, { status: 201, headers: organizationAdminHeaders });
  });
}
