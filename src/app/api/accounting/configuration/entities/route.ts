import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminErrorResponse,
  organizationAdminHeaders,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  createLegalEntity,
  legalEntityConfigurationSchema,
} from "@/modules/ledger/accounting-configuration";

export async function POST(request: NextRequest) {
  const access = await prepareOrganizationAdminMutation(request, "accounting-entity");
  if (access.response) return access.response;
  const body = await readOrganizationAdminJson(request, legalEntityConfigurationSchema);
  if (body.response) return body.response;
  try {
    const result = await createLegalEntity({
      principal: access.principal,
      requestId: randomUUID(),
      ...body.data,
    });
    return NextResponse.json(result, { status: 201, headers: organizationAdminHeaders });
  } catch (error) {
    return organizationAdminErrorResponse(error, "accounting-entity");
  }
}
