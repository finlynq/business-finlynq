import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  accountCombinationConfigurationSchema,
  createAccountCombination,
} from "@/modules/ledger/accounting-configuration";

export async function POST(request: NextRequest) {
  return organizationAdminMutationRoute(async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "accounting-account-combination");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, accountCombinationConfigurationSchema);
    if (body.response) return body.response;
    const result = await createAccountCombination({
      principal: access.principal,
      requestId,
      ...body.data,
    });
    return NextResponse.json(result, { status: 201, headers: organizationAdminHeaders });
  });
}
