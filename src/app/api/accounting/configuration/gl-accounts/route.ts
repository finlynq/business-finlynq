import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  glAccountValidityConflictDetails,
  updateGlAccount,
  updateGlAccountSchema,
} from "@/modules/ledger/chart-of-accounts-service";
import { mutationContext } from "@/modules/workspace/write-policy";

export async function PATCH(request: NextRequest) {
  return organizationAdminMutationRoute(request, async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "accounting-gl-account");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, updateGlAccountSchema);
    if (body.response) return body.response;
    try {
      const result = await updateGlAccount({
        context: mutationContext(access.principal, requestId, {
          reason: body.data.reason,
          sourceSurface: "UI",
        }),
        ...body.data,
      });
      return NextResponse.json(result, { status: 200, headers: organizationAdminHeaders });
    } catch (error) {
      const conflict = glAccountValidityConflictDetails(error);
      if (!conflict) throw error;
      return NextResponse.json(
        { error: conflict.message, code: conflict.code, details: conflict.details },
        { status: 409, headers: organizationAdminHeaders },
      );
    }
  });
}
