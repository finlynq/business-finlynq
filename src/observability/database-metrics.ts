import { queryDatabase } from "@/db/transaction";

export type DatabaseMetricRow = Readonly<{
  observed_at: Date;
  auth_failures_5m: string;
  auth_failures_1h: string;
  outbox_unpublished_count: string;
  outbox_oldest_unpublished_at: Date | null;
  outbox_legacy_request_count: string;
  outbox_unmatched_audit_count: string;
  email_pending_count: string;
  email_sending_count: string;
  email_dead_count: string;
  email_sent_5m: string;
  email_failures_5m: string;
  email_oldest_due_at: Date | null;
  email_worker_last_heartbeat_at: Date | null;
  demo_slots_total: string;
  demo_slots_ready: string;
  demo_slots_assigned: string;
  demo_slots_dirty: string;
  demo_slots_resetting: string;
  demo_slots_quarantined: string;
  demo_pool_reset_due: boolean;
  demo_last_completed_reset_at: Date | null;
}>;

const unsignedIntegerPattern = /^\d+$/;

function count(value: string): string {
  if (!unsignedIntegerPattern.test(value)) throw new Error("Operations metric count is invalid");
  return value;
}

function secondsSince(observedAt: Date, timestamp: Date | null): string {
  if (!timestamp) return "0";
  return String(Math.max(0, Math.floor((observedAt.getTime() - timestamp.getTime()) / 1_000)));
}

function presence(timestamp: Date | null): string {
  return timestamp ? "1" : "0";
}

export async function databaseMetricSnapshot(): Promise<DatabaseMetricRow> {
  const result = await queryDatabase<DatabaseMetricRow>("SELECT * FROM app.operations_metrics()");
  const row = result.rows[0];
  if (!row || !(row.observed_at instanceof Date) || !Number.isFinite(row.observed_at.getTime())) {
    throw new Error("Operations metrics are unavailable");
  }
  return row;
}

export function renderDatabasePrometheusMetrics(row: DatabaseMetricRow): string {
  const metrics: ReadonlyArray<readonly [name: string, help: string, type: "counter" | "gauge", value: string]> = [
    ["business_finlynq_metrics_snapshot_unixtime", "Unix time of the database metric snapshot.", "gauge", String(Math.floor(row.observed_at.getTime() / 1_000))],
    ["business_finlynq_auth_failures_5m", "Authentication failures and denials observed in the last five minutes.", "gauge", count(row.auth_failures_5m)],
    ["business_finlynq_auth_failures_1h", "Authentication failures and denials observed in the last hour.", "gauge", count(row.auth_failures_1h)],
    ["business_finlynq_outbox_unpublished", "Unpublished durable business outbox records.", "gauge", count(row.outbox_unpublished_count)],
    ["business_finlynq_outbox_oldest_unpublished_age_seconds", "Age of the oldest unpublished durable business outbox record.", "gauge", secondsSince(row.observed_at, row.outbox_oldest_unpublished_at)],
    ["business_finlynq_outbox_legacy_request_ids", "Legacy outbox records that predate durable request correlation.", "gauge", count(row.outbox_legacy_request_count)],
    ["business_finlynq_outbox_unmatched_audit", "Paired audit or outbox records created in the last hour that violate the versioned bidirectional contract.", "gauge", count(row.outbox_unmatched_audit_count)],
    ["business_finlynq_auth_email_pending", "Authentication email records pending delivery.", "gauge", count(row.email_pending_count)],
    ["business_finlynq_auth_email_sending", "Authentication email records holding a delivery lease.", "gauge", count(row.email_sending_count)],
    ["business_finlynq_auth_email_dead", "Authentication email records entering terminal delivery failure in the last hour, excluding controlled cancellation and supersession.", "gauge", count(row.email_dead_count)],
    ["business_finlynq_auth_email_sent_5m", "Authentication email deliveries completed in the last five minutes.", "gauge", count(row.email_sent_5m)],
    ["business_finlynq_auth_email_failures_5m", "Terminal authentication email delivery failures in the last five minutes.", "gauge", count(row.email_failures_5m)],
    ["business_finlynq_auth_email_oldest_due_age_seconds", "Age of the oldest due or expired-lease authentication email.", "gauge", secondsSince(row.observed_at, row.email_oldest_due_at)],
    ["business_finlynq_auth_email_worker_heartbeat_present", "Whether an authentication email worker heartbeat exists.", "gauge", presence(row.email_worker_last_heartbeat_at)],
    ["business_finlynq_auth_email_worker_heartbeat_age_seconds", "Age of the latest authentication email worker heartbeat.", "gauge", secondsSince(row.observed_at, row.email_worker_last_heartbeat_at)],
    ["business_finlynq_demo_slots_total", "Total isolated demo sandbox slots.", "gauge", count(row.demo_slots_total)],
    ["business_finlynq_demo_slots_ready", "Demo sandbox slots ready for a claim.", "gauge", count(row.demo_slots_ready)],
    ["business_finlynq_demo_slots_assigned", "Demo sandbox slots currently assigned.", "gauge", count(row.demo_slots_assigned)],
    ["business_finlynq_demo_slots_dirty", "Demo sandbox slots awaiting reset.", "gauge", count(row.demo_slots_dirty)],
    ["business_finlynq_demo_slots_resetting", "Demo sandbox slots currently resetting.", "gauge", count(row.demo_slots_resetting)],
    ["business_finlynq_demo_slots_quarantined", "Demo sandbox slots quarantined after reset failure.", "gauge", count(row.demo_slots_quarantined)],
    ["business_finlynq_demo_pool_reset_due", "Whether the nightly demo reset is due.", "gauge", row.demo_pool_reset_due ? "1" : "0"],
    ["business_finlynq_demo_last_reset_present", "Whether a completed nightly demo reset has been recorded.", "gauge", presence(row.demo_last_completed_reset_at)],
    ["business_finlynq_demo_last_reset_age_seconds", "Age of the last completed nightly demo reset.", "gauge", secondsSince(row.observed_at, row.demo_last_completed_reset_at)],
  ];

  return `${metrics.flatMap(([name, help, type, value]) => [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
    `${name} ${value}`,
  ]).join("\n")}\n`;
}
