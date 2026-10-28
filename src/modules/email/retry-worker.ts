import "server-only";
import { randomUUID } from "node:crypto";
import { queryDatabase } from "@/db/transaction";
import { inboundWorkerContext } from "./worker-context";
import { retryInboundMessage } from "./inbound";
import { INBOUND_RETRY_BATCH, INBOUND_RETRY_INTERVAL_MS } from "./retry-policy";
import { inboundRelaySecret } from "./secrets";
import { inboundEmailRouting } from "./routing";

type DueMessage = {
  organization_id: string; message_id: string; actor_id: string; provider: "SELF_SMTP" | "RESEND";
};

export async function runInboundRetryBatch() {
  const due = await queryDatabase<DueMessage>("SELECT * FROM app.due_inbound_email_retries($1)", [INBOUND_RETRY_BATCH]);
  let processed = 0;
  let failed = 0;
  // One message at a time; every replica/manual caller shares the durable claim.
  for (const row of due.rows) {
    try {
      const context = inboundWorkerContext({
        organizationId: row.organization_id, actorId: row.actor_id, provider: row.provider,
        requestId: `email-retry:${randomUUID()}`,
      });
      const result = await retryInboundMessage(context, row.message_id, { dueOnly: true });
      if (result.status !== "UNCHANGED") processed += 1;
    } catch {
      failed += 1;
      // The claim expires after a process failure. No provider text or message
      // identifiers enter the global application log.
    }
  }
  return { selected: due.rows.length, processed, failed };
}

let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;

export function startInboundRetryWorker() {
  if (running || process.env.BUSINESS_WRITES_ENABLED !== "true" || !inboundEmailRouting()) return;
  try {
    if (!inboundRelaySecret()) return;
  } catch {
    console.warn(JSON.stringify({ event: "email.inbound.retry_disabled", code: "INBOUND_RELAY_NOT_CONFIGURED" }));
    return;
  }
  running = true;
  const tick = async () => {
    try {
      const result = await runInboundRetryBatch();
      console.info(JSON.stringify({ event: "email.inbound.retry_cycle", ...result }));
    } catch {
      console.warn(JSON.stringify({ event: "email.inbound.retry_cycle_failed", code: "INBOUND_RETRY_UNAVAILABLE" }));
    } finally {
      timer = setTimeout(() => { void tick(); }, INBOUND_RETRY_INTERVAL_MS);
      timer.unref();
    }
  };
  timer = setTimeout(() => { void tick(); }, INBOUND_RETRY_INTERVAL_MS);
  timer.unref();
}
