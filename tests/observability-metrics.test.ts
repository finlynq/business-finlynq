import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryDatabase: vi.fn() }));
vi.mock("@/db/transaction", () => ({ queryDatabase: mocks.queryDatabase }));

import { GET as metrics } from "@/app/api/metrics/route";
import { requestIdFor } from "@/observability/request-correlation";
import {
  recordRequestObservation,
  recordRouteFailure,
  renderRuntimePrometheusMetrics,
  resetRuntimeMetricsForTest,
} from "@/observability/runtime-metrics";

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

function databaseRow() {
  const observedAt = new Date("2026-08-31T12:00:00.000Z");
  return {
    observed_at: observedAt,
    auth_failures_5m: "2",
    auth_failures_1h: "3",
    outbox_unpublished_count: "4",
    outbox_oldest_unpublished_at: new Date("2026-08-31T11:58:00.000Z"),
    outbox_legacy_request_count: "0",
    outbox_unmatched_audit_count: "0",
    email_pending_count: "1",
    email_sending_count: "0",
    email_dead_count: "0",
    email_sent_5m: "2",
    email_failures_5m: "0",
    email_oldest_due_at: null,
    email_worker_last_heartbeat_at: new Date("2026-08-31T11:59:30.000Z"),
    demo_slots_total: "128",
    demo_slots_ready: "120",
    demo_slots_assigned: "8",
    demo_slots_dirty: "0",
    demo_slots_resetting: "0",
    demo_slots_quarantined: "0",
    demo_pool_reset_due: false,
    demo_last_completed_reset_at: new Date("2026-08-31T08:15:00.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRuntimeMetricsForTest();
  mocks.queryDatabase.mockResolvedValue({ rows: [databaseRow()] });
});

describe("internal observability metrics", () => {
  it("keeps the public endpoint absent and never queries aggregate state", async () => {
    const response = await metrics(new NextRequest("https://business.finlynq.com/api/metrics"));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.queryDatabase).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("Not found.\n");
  });

  it("renders only aggregate, allowlisted metrics on the private listener", async () => {
    recordRequestObservation(204, 275);
    const response = await metrics(new NextRequest("http://127.0.0.1:3100/api/metrics", {
      headers: { "X-Business-Finlynq-Internal-Metrics": "1" },
    }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(mocks.queryDatabase).toHaveBeenCalledWith("SELECT * FROM app.operations_metrics()");
    expect(body).toContain("business_finlynq_api_requests_total 1");
    expect(body).toContain("business_finlynq_api_request_duration_seconds_count 1");
    expect(body).toContain("business_finlynq_auth_failures_5m 2");
    expect(body).toContain("business_finlynq_outbox_oldest_unpublished_age_seconds 120");
    expect(body).toContain("business_finlynq_demo_slots_ready 120");
    expect(body).not.toContain("organization_id");
    expect(body).not.toContain("user_id");
    expect(body).not.toContain("currency");
    expect(body).not.toContain("amount");
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
    const labels = [...body.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    expect(new Set(labels)).toEqual(new Set([
      'le="0.05"', 'le="0.1"', 'le="0.25"', 'le="0.5"', 'le="1"',
      'le="2.5"', 'le="5"', 'le="10"', 'le="+Inf"',
    ]));
  });

  it("fails closed with a redacted structured event when collection fails", async () => {
    mocks.queryDatabase.mockRejectedValueOnce(new Error("tenant=user@example.com amount=900"));
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await metrics(new NextRequest("http://127.0.0.1:3100/api/metrics", {
        headers: { "X-Business-Finlynq-Internal-Metrics": "1" },
      }));

      expect(response.status).toBe(503);
      const loggedEvent = JSON.parse(String(logging.mock.calls[0]?.[0]));
      expect(loggedEvent).toMatchObject({
        event: "route.failure",
        operation: "metrics-readiness",
        errorType: "Error",
      });
      expect(Object.keys(loggedEvent).sort()).toEqual([
        "errorType",
        "event",
        "operation",
        "requestId",
      ]);
      expect(loggedEvent).not.toHaveProperty("message");
      expect(loggedEvent).not.toHaveProperty("tenant");
      expect(loggedEvent).not.toHaveProperty("amount");
    } finally {
      logging.mockRestore();
    }
  });

  it("uses a stable generated request ID throughout a direct request", () => {
    const request = new NextRequest("http://127.0.0.1:3100/api/live", {
      headers: { "X-Request-Id": "invalid" },
    });
    expect(requestIdFor(request)).toBe(requestIdFor(request));
    expect(requestIdFor(request)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("counts contained route exceptions independently of HTTP status mapping", () => {
    recordRouteFailure();
    const rendered = renderRuntimePrometheusMetrics();

    expect(rendered).toContain("business_finlynq_api_route_failures_total 1");
    expect(rendered).toContain("business_finlynq_api_server_errors_total 0");
  });

  it("keeps every API route inside the measured coverage contract", () => {
    const apiRoot = join(process.cwd(), "src", "app", "api");
    const observedBoundary = /observeRouteHandler\(|create(?:Subledger|Banking)?MutationRoute(?:<|\()|organizationAdminMutationRoute\(/;

    for (const path of routeFiles(apiRoot)) {
      expect(readFileSync(path, "utf8"), relative(apiRoot, path)).toMatch(observedBoundary);
    }
  });

  it("keeps host telemetry atomic and labels limited to reviewed job names", () => {
    const monitor = readFileSync(
      join(process.cwd(), "deploy", "monitoring", "check-production.sh"),
      "utf8",
    );
    const alerts = readFileSync(
      join(process.cwd(), "deploy", "monitoring", "prometheus-alerts.yml"),
      "utf8",
    );
    const accountingVerifier = readFileSync(
      join(process.cwd(), "deploy", "monitoring", "run-accounting-evidence-check.sh"),
      "utf8",
    );
    const receiverHealth = readFileSync(
      join(process.cwd(), "deploy", "backup-receiver", "check-health.sh"),
      "utf8",
    );
    const emittedLabels = [...monitor.matchAll(/printf '[^'\n]*business_finlynq_[^'\n]*\{([^}]+)\}/g)]
      .map((match) => match[1]);

    expect(monitor).toContain('metrics_temporary="$(mktemp "${monitor_metrics_file}.tmp.XXXXXX")"');
    expect(monitor).toContain('mv -f -- "$metrics_temporary" "$monitor_metrics_file"');
    expect(monitor).toContain("business_finlynq_backup_verification_status");
    expect(monitor).toContain("business_finlynq_scheduled_job_last_run_success");
    expect(monitor).toContain("business_finlynq_auth_email_worker_expected");
    expect(monitor).not.toContain("verify_accounting_evidence");
    expect(accountingVerifier).toContain("flock --exclusive");
    expect(accountingVerifier).toContain("ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS");
    expect(accountingVerifier).toContain("business_finlynq_accounting_evidence_verification_success");
    expect(accountingVerifier).toContain('mv -f -- "$metrics_temporary" "$accounting_metrics_file"');
    expect(receiverHealth).toContain("business_finlynq_backup_receiver_health_success");
    expect(receiverHealth).toContain('mv -f -- "$metrics_temporary" "$RECEIVER_HEALTH_METRICS_FILE"');
    expect(new Set(emittedLabels)).toEqual(new Set([
      'job="encrypted_backup"',
      'job="demo_reconciliation"',
    ]));
    expect(alerts).toContain("business_finlynq_backup_verification_status == 0");
    expect(alerts).toContain("business_finlynq_outbox_unmatched_audit > 0");
    expect(alerts).toContain("business_finlynq_outbox_legacy_request_ids > 0");
    expect(alerts).toContain("business_finlynq_auth_email_worker_expected == 1");
    expect(alerts).toContain("absent(business_finlynq_host_monitor_success) == 1");
    expect(alerts).toContain("business_finlynq_api_route_failures_total[5m]");
    expect(alerts).toContain("business_finlynq_accounting_evidence_verification_last_success_unixtime");
    expect(alerts).toContain("business_finlynq_backup_receiver_health_success");
    expect(alerts).toContain("severity: critical");
    expect(alerts).not.toMatch(/organization|tenant|customer|email_address|currency|amount/);
  });

  it("keeps systemd demo reconciliation writable and recognizes a newer pool recovery", () => {
    const monitor = readFileSync(
      join(process.cwd(), "deploy", "monitoring", "check-production.sh"),
      "utf8",
    );
    const demoService = readFileSync(
      join(process.cwd(), "deploy", "systemd", "business-finlynq-demo-reconcile.service"),
      "utf8",
    );
    const scheduleVerifier = readFileSync(
      join(process.cwd(), "deploy", "systemd", "verify-backup-schedule.sh"),
      "utf8",
    );

    expect(demoService).toContain(
      "Environment=DEMO_RESET_LOCK_FILE=/var/lib/business-finlynq/demo-sandbox-maintenance.lock",
    );
    expect(demoService).toContain("StateDirectory=business-finlynq");
    expect(demoService).toContain("ProtectHome=read-only");
    expect(scheduleVerifier).toContain(
      "loaded demo-reconcile writable lock state differs from the candidate",
    );
    expect(monitor).toContain(
      "pool_last_completed_reset_unixtime > demo_job_last_run_unixtime",
    );
    expect(monitor).toContain("demo_job_last_success=1");
    expect(monitor).toContain(
      "latest demo reconciliation failed without a newer successful pool recovery",
    );
  });

  it("excludes controlled email cancellation and supersession from delivery dead letters", () => {
    const migration = readFileSync(
      join(process.cwd(), "migrations", "drizzle", "0032_observability_correlation_metrics.sql"),
      "utf8",
    );

    expect(migration).toContain("upper(coalesce(email.last_error_code, '')) NOT IN");
    expect(migration).toContain("'CANCELLED'");
    expect(migration).toContain("'INVALIDATED_BY_MFA_ENROLLMENT'");
    expect(migration).toContain("'SUPERSEDED_BY_INVITATION'");
    expect(migration).toContain("'SUPERSEDED_BY_SIGNUP'");
  });

  it("keeps the executable synthetic drill content-free and end-to-end", () => {
    const drill = readFileSync(
      join(process.cwd(), "deploy", "monitoring", "run-observability-drill.sh"),
      "utf8",
    );
    const ruleTests = readFileSync(
      join(process.cwd(), "deploy", "monitoring", "prometheus-alerts.test.yml"),
      "utf8",
    );

    expect(drill).toContain('promtool check rules "$rule_file"');
    expect(drill).toContain('promtool test rules "$(basename -- "$rule_test_file")"');
    expect(drill).toContain("/^x-request-id:/");
    expect(drill).toContain("FROM public.audit_events WHERE request_id = :'request_id'");
    expect(drill).toContain("FROM public.outbox_events WHERE request_id = :'request_id'");
    expect(drill).toContain('[[ "$request_id" =~ ^[0-9a-f]{8}');
    expect(drill).toContain('[[ "$request_id" != "$spoofed_request_id" ]]');
    expect(drill).toContain('"request_id"[[:space:]]*:[[:space:]]*"');
    expect(drill).toContain('edgeAccessLog: "correlated"');
    expect(drill).toContain("X-Business-Finlynq-Internal-Health: 1");
    expect(drill).toContain("X-Business-Finlynq-Internal-Metrics: 1");
    expect(drill).toContain('write_drill_metric 0');
    expect(drill).toContain('== "delivered"');
    expect(drill).not.toMatch(/business_finlynq_observability_drill_failure\{[^}]+\}/);
    expect(ruleTests).toContain("alertname: BusinessFinlynqSyntheticFailure");
    expect(ruleTests).toContain("alertname: BusinessFinlynqAccountingEvidenceInvalid");
  });

  it("keeps worker terminal logging structured and redacted", () => {
    const worker = readFileSync(
      join(process.cwd(), "src", "workers", "auth-email-worker.ts"),
      "utf8",
    );

    expect(worker).toContain('event: "job.failure"');
    expect(worker).toContain('job: "authentication-email-delivery"');
    expect(worker).not.toContain("error.message");
    expect(worker).not.toContain("error.stack");
  });
});
