import { NextRequest, NextResponse } from "next/server";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  createAccountingHierarchy,
  createAccountingHierarchySchema,
} from "@/modules/ledger/accounting-hierarchies";

export async function POST(request: NextRequest) {
  return organizationAdminMutationRoute(request, async (requestId) => {
    const access = await prepareOrganizationAdminMutation(request, "accounting-hierarchy-create");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, createAccountingHierarchySchema, 524_288);
    if (body.response) return body.response;
    const result = await createAccountingHierarchy({
      principal: access.principal,
      requestId,
      ...body.data,
    });
    return NextResponse.json(result, { status: 201, headers: organizationAdminHeaders });
  });
}
