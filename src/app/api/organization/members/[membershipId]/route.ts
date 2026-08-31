import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  assignOrganizationMemberRole,
  revokeOrganizationMemberSessions,
  setOrganizationMemberActive,
} from "@/modules/identity/organization-administration";

const reason = z.string().trim().min(8).max(500);
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ASSIGN_ROLE"),
    roleId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    reason,
  }),
  z.object({
    action: z.enum(["SUSPEND", "REACTIVATE"]),
    expectedVersion: z.number().int().positive(),
    reason,
  }),
  z.object({ action: z.literal("REVOKE_SESSIONS"), reason }),
]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ membershipId: string }> },
) {
  return organizationAdminMutationRoute(request, async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "member");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, schema);
    if (body.response) return body.response;
    const membershipId = z.uuid().safeParse((await params).membershipId);
    if (!membershipId.success) {
      return NextResponse.json(
        { error: "The member identifier is invalid." },
        { status: 400, headers: organizationAdminHeaders },
      );
    }
    const common = {
      principal: access.principal,
      requestId,
      membershipId: membershipId.data,
      reason: body.data.reason,
    };
    if (body.data.action === "ASSIGN_ROLE") {
      return NextResponse.json(await assignOrganizationMemberRole({
        ...common,
        roleId: body.data.roleId,
        expectedVersion: body.data.expectedVersion,
      }), { headers: organizationAdminHeaders });
    }
    if (body.data.action === "REVOKE_SESSIONS") {
      return NextResponse.json(
        await revokeOrganizationMemberSessions(common),
        { headers: organizationAdminHeaders },
      );
    }
    return NextResponse.json(await setOrganizationMemberActive({
      ...common,
      expectedVersion: body.data.expectedVersion,
      active: body.data.action === "REACTIVATE",
    }), { headers: organizationAdminHeaders });
  });
}
