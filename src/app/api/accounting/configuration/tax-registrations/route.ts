import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminErrorResponse,
  organizationAdminHeaders,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  configureTaxRegistration,
  taxRegistrationConfigurationSchema,
} from "@/modules/ledger/accounting-configuration";

export async function POST(request: NextRequest) {
  const access = await prepareOrganizationAdminMutation(request, "accounting-tax-registration");
  if (access.response) return access.response;
  const body = await readOrganizationAdminJson(request, taxRegistrationConfigurationSchema);
  if (body.response) return body.response;
  try {
    const result = await configureTaxRegistration({
      principal: access.principal,
      requestId: randomUUID(),
      ...body.data,
    });
    return NextResponse.json(result, { status: 201, headers: organizationAdminHeaders });
  } catch (error) {
    return organizationAdminErrorResponse(error, "accounting-tax-registration");
  }
}
