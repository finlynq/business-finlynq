import "server-only";
import { randomUUID } from "node:crypto";
import { queryDatabase } from "@/db/transaction";
import { retryDocumentFiling } from "./filing";
import { documentFilingWorkerContext } from "./filing-worker-context";
import { FILING_CONCURRENCY, FILING_POLL_MS } from "./filing-policy";

type DueFiling = { organization_id: string; item_id: string; actor_id: string | null };
export async function runDocumentFilingBatch() {
  const due = await queryDatabase<DueFiling>("SELECT * FROM app.due_document_filings($1)", [FILING_CONCURRENCY]);
  let checked = 0; let failed = 0; let blocked = 0;
  await Promise.all(due.rows.map(async (row) => {
    if (!row.actor_id) {
      blocked += 1;
      console.warn(JSON.stringify({ event: "document.inbox.filing.authorization_required", itemId: row.item_id }));
      return;
    }
    try {
      const context = documentFilingWorkerContext({ organizationId: row.organization_id, actorId: row.actor_id,
        itemId: row.item_id, requestId: `filing-recovery:${randomUUID()}` });
      await retryDocumentFiling(context, { itemId: row.item_id });
      checked += 1;
    } catch { failed += 1; }
  }));
  return { selected: due.rows.length, checked, failed, blocked };
}
let running = false;
export function startDocumentFilingWorker() {
  if (running || process.env.BUSINESS_WRITES_ENABLED !== "true") return;
  running = true;
  const tick = async () => {
    try {
      const result = await runDocumentFilingBatch();
      if (result.selected) console.info(JSON.stringify({ event: "document.inbox.filing.recovery_cycle", ...result }));
    } catch { console.warn(JSON.stringify({ event: "document.inbox.filing.recovery_unavailable", errorCode: "STORAGE_FILING_WORKER_UNAVAILABLE" })); }
    finally { const timer = setTimeout(() => { void tick(); }, FILING_POLL_MS); timer.unref(); }
  };
  const timer = setTimeout(() => { void tick(); }, FILING_POLL_MS); timer.unref();
}
