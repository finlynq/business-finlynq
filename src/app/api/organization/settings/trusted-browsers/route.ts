import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import { updateOrganizationTrustedBrowserPolicy } from "@/modules/identity/organization-administration";

const schema = z.object({
  enabled: z.boolean(),
  durationDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(8).max(500),
}).strict();

export async function PATCH(request: NextRequest) {
  return organizationAdminMutationRoute(request, async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "trusted-browser-policy");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, schema);
    if (body.response) return body.response;
    const result = await updateOrganizationTrustedBrowserPolicy({
      principal: access.principal,
      requestId,
      ...body.data,
    });
    return NextResponse.json(result, { headers: organizationAdminHeaders });
  });
}
