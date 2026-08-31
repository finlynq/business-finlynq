import { NextResponse, type NextRequest } from "next/server";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import {
  databaseMetricSnapshot,
  renderDatabasePrometheusMetrics,
} from "@/observability/database-metrics";
import { requestIdFor, responseWithRequestId } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import { renderRuntimePrometheusMetrics } from "@/observability/runtime-metrics";

export const dynamic = "force-dynamic";

const internalMetricsHeader = "x-business-finlynq-internal-metrics";
const responseHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

async function get(request: NextRequest) {
  const requestId = requestIdFor(request);
  if (request.headers.get(internalMetricsHeader) !== "1") {
    return responseWithRequestId(new NextResponse("Not found.\n", {
      status: 404,
      headers: responseHeaders,
    }), requestId);
  }

  try {
    const database = await databaseMetricSnapshot();
    return responseWithRequestId(new NextResponse(
      `${renderRuntimePrometheusMetrics()}${renderDatabasePrometheusMetrics(database)}`,
      { status: 200, headers: responseHeaders },
    ), requestId);
  } catch (error) {
    logRouteFailure("metrics-readiness", requestId, error);
    return responseWithRequestId(new NextResponse("Metrics unavailable.\n", {
      status: 503,
      headers: responseHeaders,
    }), requestId);
  }
}

export const GET = observeRouteHandler("metrics-readiness", get);
