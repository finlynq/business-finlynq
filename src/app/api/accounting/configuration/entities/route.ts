import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  createLegalEntity,
  legalEntityConfigurationSchema,
} from "@/modules/ledger/accounting-configuration";

export async function POST(request: NextRequest) {
  return organizationAdminMutationRoute(async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "accounting-entity");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, legalEntityConfigurationSchema);
    if (body.response) return body.response;
    const result = await createLegalEntity({
      principal: access.principal,
      requestId,
      ...body.data,
    });
    return NextResponse.json(result, { status: 201, headers: organizationAdminHeaders });
  });
}
