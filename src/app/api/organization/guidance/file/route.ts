import { NextRequest } from "next/server";
import { requestPrincipal } from "@/modules/identity/session";
import { readGuidanceForPage, type GuidanceScope } from "@/modules/agent-guidance/service";
import { observeRouteHandler } from "@/observability/request-observability";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export const GET = observeRouteHandler("organization-guidance", readFile);

async function readFile(request: NextRequest): Promise<Response> {
  const principal = await requestPrincipal(request);
  if (!principal) return Response.json({ error: "Sign in to continue" }, { status: 401, headers });
  const scope = request.nextUrl.searchParams.get("scope");
  const path = request.nextUrl.searchParams.get("path");
  if ((scope !== "platform" && scope !== "client") || !path) {
    return Response.json({ error: "Choose a guidance file" }, { status: 400, headers });
  }
  try {
    const file = await readGuidanceForPage(principal, scope as GuidanceScope, path);
    return new Response(file.content, {
      headers: { ...headers, "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.path.split("/").at(-1) ?? "guidance.md")}` },
    });
  } catch {
    return Response.json({ error: "Guidance file is unavailable" }, { status: 404, headers });
  }
}
