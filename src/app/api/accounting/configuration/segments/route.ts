import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminErrorResponse,
  organizationAdminHeaders,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  configureSegment,
  segmentConfigurationSchema,
} from "@/modules/ledger/accounting-configuration";

export async function PATCH(request: NextRequest) {
  const access = await prepareOrganizationAdminMutation(request, "accounting-segment");
  if (access.response) return access.response;
  const body = await readOrganizationAdminJson(request, segmentConfigurationSchema);
  if (body.response) return body.response;
  try {
    const result = await configureSegment({
      principal: access.principal,
      requestId: randomUUID(),
      ...body.data,
    });
    return NextResponse.json(result, { headers: organizationAdminHeaders });
  } catch (error) {
    return organizationAdminErrorResponse(error, "accounting-segment");
  }
}
