import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  organizationAdminErrorResponse,
  organizationAdminHeaders,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import {
  publishAccountingHierarchy,
  publishAccountingHierarchySchema,
} from "@/modules/ledger/accounting-hierarchies";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ hierarchyId: string }> },
) {
  const hierarchyId = z.uuid().safeParse((await params).hierarchyId);
  if (!hierarchyId.success) {
    return NextResponse.json(
      { error: "Hierarchy identifier is invalid." },
      { status: 400, headers: organizationAdminHeaders },
    );
  }
  const access = await prepareOrganizationAdminMutation(request, "accounting-hierarchy-publish");
  if (access.response) return access.response;
  const body = await readOrganizationAdminJson(request, publishAccountingHierarchySchema);
  if (body.response) return body.response;
  try {
    const result = await publishAccountingHierarchy({
      principal: access.principal,
      requestId: randomUUID(),
      hierarchyId: hierarchyId.data,
      ...body.data,
    });
    return NextResponse.json(result, { headers: organizationAdminHeaders });
  } catch (error) {
    return organizationAdminErrorResponse(error, "accounting-hierarchy-publish");
  }
}
