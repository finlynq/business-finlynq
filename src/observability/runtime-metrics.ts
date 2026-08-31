const durationBucketsSeconds = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

type RuntimeMetricState = {
  startedAtSeconds: number;
  requestCount: number;
  serverErrorCount: number;
  routeFailureCount: number;
  durationSecondsSum: number;
  durationBucketCounts: number[];
};

export type RuntimeMetricSnapshot = Readonly<{
  startedAtSeconds: number;
  requestCount: number;
  serverErrorCount: number;
  routeFailureCount: number;
  durationSecondsSum: number;
  durationBucketCounts: readonly number[];
}>;

const stateKey = "__businessFinlynqRuntimeMetricsV1" as const;
type RuntimeGlobal = typeof globalThis & { [stateKey]?: RuntimeMetricState };

function initialState(): RuntimeMetricState {
  return {
    startedAtSeconds: Math.floor(Date.now() / 1_000),
    requestCount: 0,
    serverErrorCount: 0,
    routeFailureCount: 0,
    durationSecondsSum: 0,
    durationBucketCounts: durationBucketsSeconds.map(() => 0),
  };
}

export function recordRouteFailure(): void {
  state().routeFailureCount += 1;
}

function state(): RuntimeMetricState {
  const selectedGlobal = globalThis as RuntimeGlobal;
  selectedGlobal[stateKey] ??= initialState();
  return selectedGlobal[stateKey];
}

export function recordRequestObservation(status: number, durationMilliseconds: number): void {
  const selected = state();
  const durationSeconds = Number.isFinite(durationMilliseconds) && durationMilliseconds >= 0
    ? Math.min(durationMilliseconds / 1_000, 3_600)
    : 0;
  selected.requestCount += 1;
  if (status >= 500) selected.serverErrorCount += 1;
  selected.durationSecondsSum += durationSeconds;
  for (const [index, boundary] of durationBucketsSeconds.entries()) {
    if (durationSeconds <= boundary) selected.durationBucketCounts[index] += 1;
  }
}

export function runtimeMetricSnapshot(): RuntimeMetricSnapshot {
  const selected = state();
  return {
    startedAtSeconds: selected.startedAtSeconds,
    requestCount: selected.requestCount,
    serverErrorCount: selected.serverErrorCount,
    routeFailureCount: selected.routeFailureCount,
    durationSecondsSum: selected.durationSecondsSum,
    durationBucketCounts: [...selected.durationBucketCounts],
  };
}

export function renderRuntimePrometheusMetrics(snapshot = runtimeMetricSnapshot()): string {
  const lines = [
    "# HELP business_finlynq_process_started_unixtime Unix time when this application process metric store started.",
    "# TYPE business_finlynq_process_started_unixtime gauge",
    `business_finlynq_process_started_unixtime ${snapshot.startedAtSeconds}`,
    "# HELP business_finlynq_api_requests_total Observed Next.js API route requests.",
    "# TYPE business_finlynq_api_requests_total counter",
    `business_finlynq_api_requests_total ${snapshot.requestCount}`,
    "# HELP business_finlynq_api_server_errors_total Observed Next.js API route responses with a 5xx status.",
    "# TYPE business_finlynq_api_server_errors_total counter",
    `business_finlynq_api_server_errors_total ${snapshot.serverErrorCount}`,
    "# HELP business_finlynq_api_route_failures_total Contained API route exceptions, including failures mapped to a safe non-5xx response.",
    "# TYPE business_finlynq_api_route_failures_total counter",
    `business_finlynq_api_route_failures_total ${snapshot.routeFailureCount}`,
    "# HELP business_finlynq_api_request_duration_seconds Observed Next.js API route latency.",
    "# TYPE business_finlynq_api_request_duration_seconds histogram",
  ];
  for (const [index, boundary] of durationBucketsSeconds.entries()) {
    lines.push(
      `business_finlynq_api_request_duration_seconds_bucket{le="${boundary}"} ${snapshot.durationBucketCounts[index] ?? 0}`,
    );
  }
  lines.push(
    `business_finlynq_api_request_duration_seconds_bucket{le="+Inf"} ${snapshot.requestCount}`,
    `business_finlynq_api_request_duration_seconds_sum ${snapshot.durationSecondsSum.toFixed(6)}`,
    `business_finlynq_api_request_duration_seconds_count ${snapshot.requestCount}`,
  );
  return `${lines.join("\n")}\n`;
}

export function resetRuntimeMetricsForTest(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Runtime metrics can be reset only in tests");
  (globalThis as RuntimeGlobal)[stateKey] = initialState();
}
