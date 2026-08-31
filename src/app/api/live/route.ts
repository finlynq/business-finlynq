import { NextResponse } from "next/server";
import { observeRouteHandler } from "@/observability/request-observability";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

async function get() {
  return NextResponse.json({ status: "live" }, { headers });
}

export const GET = observeRouteHandler("service-liveness", get);
