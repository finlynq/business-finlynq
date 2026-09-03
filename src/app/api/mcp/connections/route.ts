import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { observeRouteHandler } from "@/observability/request-observability";
import {
  mcpSettingsFailure,
  mcpSettingsHeaders,
  readMcpSettingsJson,
  requireMcpSettingsPrincipal,
} from "@/app/api/_shared/mcp-settings-route";
import { listUserMcpConnections } from "@/modules/mcp/connection-policy";
import {
  revokeMcpConnection,
  updateMcpConnectionSchema,
  updateMcpConnectionSettings,
} from "@/modules/mcp/settings-store";

const revokeSchema = z.object({ connectionId: z.uuid() }).strict();

async function get(request: NextRequest) {
  try {
    const access = await requireMcpSettingsPrincipal(request);
    if (access.response) return access.response;
    return NextResponse.json(
      { connections: await listUserMcpConnections(access.principal) },
      { headers: mcpSettingsHeaders },
    );
  } catch (error) {
    return mcpSettingsFailure(error);
  }
}

async function patch(request: NextRequest) {
  try {
    const access = await requireMcpSettingsPrincipal(request, true);
    if (access.response) return access.response;
    const body = await readMcpSettingsJson(request, updateMcpConnectionSchema);
    if (body.response) return body.response;
    return NextResponse.json(
      await updateMcpConnectionSettings(access.principal, body.data),
      { headers: mcpSettingsHeaders },
    );
  } catch (error) {
    return mcpSettingsFailure(error);
  }
}

async function remove(request: NextRequest) {
  try {
    const access = await requireMcpSettingsPrincipal(request, true);
    if (access.response) return access.response;
    const body = await readMcpSettingsJson(request, revokeSchema);
    if (body.response) return body.response;
    const revoked = await revokeMcpConnection(access.principal, body.data.connectionId);
    return NextResponse.json({ revoked }, { status: revoked ? 200 : 404, headers: mcpSettingsHeaders });
  } catch (error) {
    return mcpSettingsFailure(error);
  }
}

export const GET = observeRouteHandler("mcp-settings", get);
export const PATCH = observeRouteHandler("mcp-settings", patch);
export const DELETE = observeRouteHandler("mcp-settings", remove);
