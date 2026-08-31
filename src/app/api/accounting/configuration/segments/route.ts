import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  configureSegment,
  segmentConfigurationSchema,
} from "@/modules/ledger/accounting-configuration";

export async function PATCH(request: NextRequest) {
  return organizationAdminMutationRoute(async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "accounting-segment");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, segmentConfigurationSchema);
    if (body.response) return body.response;
    const result = await configureSegment({
      principal: access.principal,
      requestId,
      ...body.data,
    });
    return NextResponse.json(result, { headers: organizationAdminHeaders });
  });
}
