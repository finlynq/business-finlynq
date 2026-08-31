import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import { cancelOrganizationInvitation } from "@/modules/identity/organization-administration";

const schema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(8).max(500),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ invitationId: string }> },
) {
  return organizationAdminMutationRoute(request, async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "invite-cancel");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, schema);
    if (body.response) return body.response;
    const invitationId = z.uuid().safeParse((await params).invitationId);
    if (!invitationId.success) {
      return NextResponse.json(
        { error: "The invitation identifier is invalid." },
        { status: 400, headers: organizationAdminHeaders },
      );
    }
    const result = await cancelOrganizationInvitation({
      principal: access.principal,
      requestId,
      invitationId: invitationId.data,
      ...body.data,
    });
    return NextResponse.json(result, { headers: organizationAdminHeaders });
  });
}
