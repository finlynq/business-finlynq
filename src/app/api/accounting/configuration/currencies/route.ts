import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  configureOrganizationCurrency,
  organizationCurrencyConfigurationSchema,
} from "@/modules/ledger/accounting-configuration";

export async function PATCH(request: NextRequest) {
  return organizationAdminMutationRoute(async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "accounting-currency");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, organizationCurrencyConfigurationSchema);
    if (body.response) return body.response;
    const result = await configureOrganizationCurrency({
      principal: access.principal,
      requestId,
      ...body.data,
    });
    return NextResponse.json(result, { headers: organizationAdminHeaders });
  });
}
