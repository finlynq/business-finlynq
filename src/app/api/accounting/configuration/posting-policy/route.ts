import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  changeLedgerPostingPolicy,
  postingPolicyChangeSchema,
} from "@/modules/ledger/posting-policy-service";

export async function PATCH(request: NextRequest) {
  return organizationAdminMutationRoute(request, async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "ledger-posting-policy");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, postingPolicyChangeSchema);
    if (body.response) return body.response;
    const result = await changeLedgerPostingPolicy({
      principal: access.principal,
      requestId,
      ...body.data,
    });
    return NextResponse.json(result, { headers: organizationAdminHeaders });
  });
}
