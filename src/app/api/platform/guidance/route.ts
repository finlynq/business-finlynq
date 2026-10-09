import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  organizationAdminHeaders,
  organizationAdminMutationRoute,
  prepareOrganizationAdminMutation,
  readOrganizationAdminJson,
} from "@/app/api/_shared/organization-administration-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { retirePlatformGuidanceFile, savePlatformGuidanceFile } from "@/modules/agent-guidance/service";
import { retireGuidanceFileSchema, saveGuidanceFileSchema } from "@/modules/agent-guidance/model";

async function mutate(request: NextRequest, action: "save" | "retire") {
  return organizationAdminMutationRoute(request, async (requestId) => {
    try {
      const access = await prepareOrganizationAdminMutation(request, `platform-guidance-${action}`);
      if (access.response) return access.response;
      const body = await readOrganizationAdminJson(request,
        action === "save" ? saveGuidanceFileSchema : retireGuidanceFileSchema, 32_768);
      if (body.response) return body.response;
      const result = action === "save"
        ? await savePlatformGuidanceFile(access.principal, body.data)
        : await retirePlatformGuidanceFile(access.principal, body.data);
      return NextResponse.json(result, { headers: organizationAdminHeaders });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code) : "";
      const response = code === "42501"
        ? { status: 403, message: "A current platform administrator MFA step-up is required." }
        : code === "40001"
          ? { status: 409, message: "This file changed. Reload it before saving." }
          : error instanceof z.ZodError || code === "22023" || code.startsWith("GUIDANCE_")
            ? { status: 400, message: "Check the file path, content limit, and version." }
            : { status: 500, message: "The guidance file could not be changed." };
      logRouteFailure("platform-guidance", requestId, error);
      return NextResponse.json({ error: response.message },
        { status: response.status, headers: organizationAdminHeaders });
    }
  });
}

export async function PUT(request: NextRequest) { return mutate(request, "save"); }
export async function DELETE(request: NextRequest) { return mutate(request, "retire"); }
