import { NextRequest, NextResponse } from "next/server";
import type { ZodType } from "zod";
import { requestPrincipal, type SessionPrincipal } from "@/modules/identity/session";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";

export const mcpSettingsHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

export async function requireMcpSettingsPrincipal(
  request: NextRequest,
  mutation = false,
): Promise<Readonly<{ principal: SessionPrincipal; response?: never }> | Readonly<{ principal?: never; response: NextResponse }>> {
  if (mutation && !validateSameOriginMutation(request)) {
    return { response: NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers: mcpSettingsHeaders }) };
  }
  const principal = await requestPrincipal(request);
  if (!principal) {
    return { response: NextResponse.json({ error: "Sign in to continue." }, { status: 401, headers: mcpSettingsHeaders }) };
  }
  if (principal.sessionMode !== "real") {
    return { response: NextResponse.json({ error: "Remote MCP connections are unavailable in demo sessions." }, { status: 403, headers: mcpSettingsHeaders }) };
  }
  return { principal };
}

export async function readMcpSettingsJson<Output>(
  request: NextRequest,
  schema: ZodType<Output>,
): Promise<Readonly<{ data: Output; response?: never }> | Readonly<{ data?: never; response: NextResponse }>> {
  try {
    const result = schema.safeParse(await readBoundedJson(request, 32_768));
    if (!result.success) {
      return { response: NextResponse.json({ error: "Check the MCP settings and try again." }, { status: 400, headers: mcpSettingsHeaders }) };
    }
    return { data: result.data };
  } catch (error) {
    if (error instanceof MutationBodyError) {
      return { response: NextResponse.json({ error: error.message }, { status: error.status, headers: mcpSettingsHeaders }) };
    }
    throw error;
  }
}

export function mcpSettingsFailure(error: unknown): NextResponse {
  const rawMessage = error instanceof Error ? error.message : "";
  const controlled = rawMessage.startsWith("Recent MFA verification") ||
    rawMessage.includes("changed or is no longer active") ||
    rawMessage.includes("unavailable in demo");
  const message = controlled ? rawMessage : "The MCP setting could not be changed.";
  const status = message.startsWith("Recent MFA verification") ? 428
    : message.includes("changed or is no longer active") ? 409
      : message.includes("unavailable in demo") ? 403
        : 400;
  return NextResponse.json({ error: message }, { status, headers: mcpSettingsHeaders });
}
