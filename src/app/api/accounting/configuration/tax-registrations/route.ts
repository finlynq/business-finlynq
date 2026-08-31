import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  configureTaxRegistration,
  taxRegistrationConfigurationSchema,
} from "@/modules/ledger/accounting-configuration";

export async function POST(request: NextRequest) {
  return organizationAdminMutationRoute(async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "accounting-tax-registration");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, taxRegistrationConfigurationSchema);
    if (body.response) return body.response;
    const result = await configureTaxRegistration({
      principal: access.principal,
      requestId,
      ...body.data,
    });
    return NextResponse.json(result, { status: 201, headers: organizationAdminHeaders });
  });
}
