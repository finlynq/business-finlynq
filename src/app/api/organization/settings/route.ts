import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  organizationAdminErrorResponse,
  organizationAdminHeaders,
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
  const access = await prepareOrganizationAdminMutation(request, "settings");
  if (access.response) return access.response;
  const body = await readOrganizationAdminJson(request, schema);
  if (body.response) return body.response;
  try {
    const result = await updateOrganizationProfile({
      principal: access.principal,
      requestId: randomUUID(),
      ...body.data,
    });
    return NextResponse.json(result, { headers: organizationAdminHeaders });
  } catch (error) {
    return organizationAdminErrorResponse(error, "update-settings");
  }
}
