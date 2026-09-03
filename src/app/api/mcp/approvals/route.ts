import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { observeRouteHandler } from "@/observability/request-observability";
import {
  mcpSettingsFailure,
  mcpSettingsHeaders,
  readMcpSettingsJson,
  requireMcpSettingsPrincipal,
} from "@/app/api/_shared/mcp-settings-route";
import { decideMcpApproval, listPendingMcpApprovals } from "@/modules/mcp/settings-store";

const decisionSchema = z.object({
  approvalId: z.uuid(),
  decision: z.enum(["APPROVED", "REJECTED"]),
}).strict();

async function get(request: NextRequest) {
  try {
    const access = await requireMcpSettingsPrincipal(request);
    if (access.response) return access.response;
    return NextResponse.json(
      { approvals: await listPendingMcpApprovals(access.principal) },
      { headers: mcpSettingsHeaders },
    );
  } catch (error) {
    return mcpSettingsFailure(error);
  }
}

async function post(request: NextRequest) {
  try {
    const access = await requireMcpSettingsPrincipal(request, true);
    if (access.response) return access.response;
    const body = await readMcpSettingsJson(request, decisionSchema);
    if (body.response) return body.response;
    const decided = await decideMcpApproval(access.principal, body.data);
    return NextResponse.json({ decided }, { status: decided ? 200 : 404, headers: mcpSettingsHeaders });
  } catch (error) {
    return mcpSettingsFailure(error);
  }
}

export const GET = observeRouteHandler("mcp-settings", get);
export const POST = observeRouteHandler("mcp-settings", post);
