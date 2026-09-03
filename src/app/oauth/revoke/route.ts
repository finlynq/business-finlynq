import { readFormBody } from "@/modules/mcp/oauth-http";
import { revokeOAuthToken } from "@/modules/mcp/oauth-store";
import { oauthErrorResponse } from "@/modules/mcp/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await readFormBody(request);
    const token = form.get("token");
    if (token) await revokeOAuthToken(token, form.get("client_id") ?? undefined);
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
