import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import { inviteOrganizationMember } from "@/modules/identity/organization-administration";

const schema = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(160),
  roleId: z.uuid(),
  reason: z.string().trim().min(8).max(500),
});

export async function POST(request: NextRequest) {
  return organizationAdminMutationRoute(async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "invite");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, schema);
    if (body.response) return body.response;
    const result = await inviteOrganizationMember({
      principal: access.principal,
      requestId,
      ...body.data,
    });
    return NextResponse.json(result, { status: 201, headers: organizationAdminHeaders });
  });
}
