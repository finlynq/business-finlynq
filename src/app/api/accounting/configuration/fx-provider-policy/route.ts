import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  configureOrganizationFxProviderPolicy,
  organizationFxProviderPolicyConfigurationSchema,
} from "@/modules/fx/provider-policy";

export async function PATCH(request: NextRequest) {
  return organizationAdminMutationRoute(request, async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "fx-provider-policy");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(
      request,
      organizationFxProviderPolicyConfigurationSchema,
    );
    if (body.response) return body.response;
    const result = await configureOrganizationFxProviderPolicy({
      principal: access.principal,
      requestId,
      sourceSurface: "API",
      ...body.data,
    });
    return NextResponse.json(result, { headers: organizationAdminHeaders });
  });
}
