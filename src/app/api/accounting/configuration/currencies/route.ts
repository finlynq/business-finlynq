import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminErrorResponse,
  organizationAdminHeaders,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  configureOrganizationCurrency,
  organizationCurrencyConfigurationSchema,
} from "@/modules/ledger/accounting-configuration";

export async function PATCH(request: NextRequest) {
  const access = await prepareOrganizationAdminMutation(request, "accounting-currency");
  if (access.response) return access.response;
  const body = await readOrganizationAdminJson(request, organizationCurrencyConfigurationSchema);
  if (body.response) return body.response;
  try {
    const result = await configureOrganizationCurrency({
      principal: access.principal,
      requestId: randomUUID(),
      ...body.data,
    });
    return NextResponse.json(result, { headers: organizationAdminHeaders });
  } catch (error) {
    return organizationAdminErrorResponse(error, "accounting-currency");
  }
}
