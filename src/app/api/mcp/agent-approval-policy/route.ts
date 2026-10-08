import { NextRequest, NextResponse } from "next/server";
import { observeRouteHandler } from "@/observability/request-observability";
import { mcpSettingsFailure, mcpSettingsHeaders, readMcpSettingsJson, requireMcpSettingsPrincipal } from "@/app/api/_shared/mcp-settings-route";
import { agentApprovalPolicyChangeSchema, changeAgentApprovalPolicy, readAgentApprovalPolicy } from "@/modules/mcp/agent-approval-policy";

async function get(request: NextRequest) {
  try {
    const access = await requireMcpSettingsPrincipal(request);
    if (access.response) return access.response;
    return NextResponse.json(await readAgentApprovalPolicy(access.principal), { headers: mcpSettingsHeaders });
  } catch (error) { return mcpSettingsFailure(error); }
}

async function post(request: NextRequest) {
  try {
    const access = await requireMcpSettingsPrincipal(request, true);
    if (access.response) return access.response;
    const body = await readMcpSettingsJson(request, agentApprovalPolicyChangeSchema);
    if (body.response) return body.response;
    return NextResponse.json(await changeAgentApprovalPolicy(access.principal, body.data), { headers: mcpSettingsHeaders });
  } catch (error) { return mcpSettingsFailure(error); }
}

export const GET = observeRouteHandler("mcp-settings", get);
export const POST = observeRouteHandler("mcp-settings", post);
