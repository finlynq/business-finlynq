import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import { updateOrganizationProfile } from "@/modules/identity/organization-administration";

const schema = z.object({
  displayName: z.string().trim().min(2).max(160),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(8).max(500),
});

export async function PATCH(request: NextRequest) {
  return organizationAdminMutationRoute(async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "settings");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, schema);
    if (body.response) return body.response;
    const result = await updateOrganizationProfile({
      principal: access.principal,
      requestId,
      ...body.data,
    });
    return NextResponse.json(result, { headers: organizationAdminHeaders });
  });
}
