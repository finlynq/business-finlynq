import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminErrorResponse,
  organizationAdminHeaders,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  changeLedgerPostingPolicy,
  postingPolicyChangeSchema,
} from "@/modules/ledger/posting-policy-service";

export async function PATCH(request: NextRequest) {
  const access = await prepareOrganizationAdminMutation(request, "ledger-posting-policy");
  if (access.response) return access.response;
  const body = await readOrganizationAdminJson(request, postingPolicyChangeSchema);
  if (body.response) return body.response;
  try {
    const result = await changeLedgerPostingPolicy({
      principal: access.principal,
      requestId: randomUUID(),
      ...body.data,
    });
    return NextResponse.json(result, { headers: organizationAdminHeaders });
  } catch (error) {
    return organizationAdminErrorResponse(error, "ledger-posting-policy");
  }
}
