import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  saveAccountingHierarchy,
  saveAccountingHierarchySchema,
} from "@/modules/ledger/accounting-hierarchies";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ hierarchyId: string }> },
) {
  return organizationAdminMutationRoute(request, async (requestId) => {
    const hierarchyId = z.uuid().safeParse((await params).hierarchyId);
    if (!hierarchyId.success) {
      return NextResponse.json(
        { error: "Hierarchy identifier is invalid." },
        { status: 400, headers: organizationAdminHeaders },
      );
    }
    const access = await prepareOrganizationAdminMutation(request, "accounting-hierarchy-save");
    if (access.response) return access.response;
    const body = await readOrganizationAdminJson(request, saveAccountingHierarchySchema, 524_288);
    if (body.response) return body.response;
    const result = await saveAccountingHierarchy({
      principal: access.principal,
      requestId,
      hierarchyId: hierarchyId.data,
      ...body.data,
    });
    return NextResponse.json(result, { headers: organizationAdminHeaders });
  });
}
