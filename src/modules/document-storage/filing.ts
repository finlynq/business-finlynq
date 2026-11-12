import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { retryFilingSchema } from "./model";
import { StorageError } from "./provider";
import { assertDirectChild, assertStorageFolder } from "./boundaries";
import { validatedCloudBytes } from "./evidence";
import { itemMetadata, itemProcessing, itemSourceMetadata, loadInboxItem, type InboxRow } from "./inbox-store";
import { assertStorageWrite, encryptStorageValue, loadConnection, prepareConnectedDrive, resolvePreparedDrive } from "./store";
import { assertFilingWorkerScope } from "./filing-worker-context";
import { FILING_CONCURRENCY, FILING_DEADLINE_MS, FILING_LEASE_SECONDS, FILING_MAX_ATTEMPTS, filingRetrySeconds } from "./filing-policy";

// Each committed checkpoint is a distinct audited mutation. Keep the parent
// request visible while avoiding the audit idempotency key of a prior phase.
function filingTransaction<T>(context: TenantTransactionContext, work: (client: PoolClient) => Promise<T>) {
  return withTenantTransaction(context, async (client) => {
    await client.query("SELECT set_config('app.request_id',$1,true)", [`${context.requestId.slice(0, 150)}:filing:${randomUUID()}`]);
    return work(client);
  });
}

async function result(client: PoolClient, row: InboxRow) {
  const item = await itemMetadata(client, row);
  return { item, filingPending: row.status !== "FILED" };
}
function assertCompleted(row: InboxRow) {
  if (!row.completion_hash || !["READY_TO_FILE", "FILING_FAILED", "FILED"].includes(row.status)) {
    throw new StorageError("STORAGE_NOT_COMPLETED", "Save a processing result before filing this document.");
  }
}
function liveClaim(row: InboxRow) { return Boolean(row.filing_token && row.filing_lease_until && row.filing_lease_until.getTime() > Date.now()); }

export async function getDocumentFilingStatus(context: TenantTransactionContext, input: z.input<typeof retryFilingSchema>, access: "read" | "manage" = "read") {
  const { itemId } = retryFilingSchema.parse(input);
  assertFilingWorkerScope(context, itemId);
  return filingTransaction(context, async (client) => {
    const row = (await client.query<InboxRow>("SELECT * FROM document_inbox_items WHERE organization_id=$1 AND id=$2", [context.organizationId, itemId])).rows[0];
    if (!row) throw new StorageError("STORAGE_ITEM_MISSING", "This inbox item is unavailable.");
    await loadConnection(client, context, row.connection_id, access, access === "manage", "none");
    assertCompleted(row);
    if (access === "manage" && row.status !== "FILED") await assertStorageWrite(client, context);
    return result(client, row);
  });
}

async function enqueue(context: TenantTransactionContext, itemId: string) {
  return filingTransaction(context, async (client) => {
    await assertStorageWrite(client, context);
    const { row } = await loadInboxItem(client, context, itemId);
    assertCompleted(row);
    if (row.status === "FILED" || liveClaim(row)
      || (row.status === "READY_TO_FILE" && row.filing_next_retry_at && row.filing_next_retry_at.getTime() > Date.now())) return result(client, row);
    const reset = row.status === "FILING_FAILED" || (row.filing_attempt_count ?? 0) >= FILING_MAX_ATTEMPTS;
    const processing = await itemProcessing(client, row);
    const stored = await encryptStorageValue(client, row, "document_inbox_items", "processing_ciphertext", { ...processing, reason: undefined });
    const updated = (await client.query<InboxRow>(`UPDATE document_inbox_items SET status='READY_TO_FILE',filing_actor_id=$3,
      filing_queued_at=now(),filing_next_retry_at=now(),filing_token=NULL,filing_lease_until=NULL,filing_error_code=NULL,
      filing_stage=NULL,filing_attempt_count=CASE WHEN $4 THEN 0 ELSE filing_attempt_count END,processing_ciphertext=$5
      WHERE organization_id=$1 AND id=$2 RETURNING *`, [context.organizationId, itemId, context.actorId, reset, stored])).rows[0];
    return result(client, updated);
  });
}

export async function scheduleDocumentFiling(context: TenantTransactionContext, input: z.input<typeof retryFilingSchema>, schedule: (task: () => Promise<void>) => void) {
  const command = retryFilingSchema.parse(input);
  assertFilingWorkerScope(context, command.itemId);
  const current = await enqueue(context, command.itemId);
  if (current.item.status === "FILED") return current;
  if (current.item.filing?.state === "QUEUED" || current.item.filing?.state === "STALLED") {
    try { schedule(async () => { await retryDocumentFiling(context, command).catch(() => undefined); }); }
    catch { console.warn(JSON.stringify({ event: "document.inbox.filing.wake_failed", itemId: command.itemId, requestId: context.requestId })); }
  }
  return { ...current, instruction: `Filing state: ${current.item.filing?.state ?? "QUEUED"}. The work is saved durably. Poll get_document_filing_status with this itemId; accounting and evidence will not be repeated.` };
}

async function claim(context: TenantTransactionContext, itemId: string) {
  return filingTransaction(context, async (client) => {
    await assertStorageWrite(client, context);
    const { row, connection } = await loadInboxItem(client, context, itemId);
    assertCompleted(row);
    if (row.status === "FILED" || liveClaim(row) || (row.filing_next_retry_at && row.filing_next_retry_at.getTime() > Date.now())) {
      return { kind: "unchanged" as const, current: await result(client, row) };
    }
    if ((row.filing_attempt_count ?? 0) >= FILING_MAX_ATTEMPTS) {
      const updated = (await client.query<InboxRow>(`UPDATE document_inbox_items SET status='FILING_FAILED',filing_error_code='STORAGE_FILING_EXHAUSTED',
        filing_token=NULL,filing_lease_until=NULL,filing_next_retry_at=NULL,filing_stage=NULL WHERE organization_id=$1 AND id=$2 RETURNING *`, [context.organizationId, itemId])).rows[0];
      console.warn(JSON.stringify({ event: "document.inbox.filing.exhausted", itemId, requestId: context.requestId }));
      return { kind: "unchanged" as const, current: await result(client, updated) };
    }
    // Connection and item locks cover admission only; no provider I/O runs here.
    const active = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM document_inbox_items WHERE organization_id=$1 AND connection_id=$2
      AND filing_token IS NOT NULL AND filing_lease_until>now()`, [context.organizationId, connection.id]);
    if (active.rows[0].n >= FILING_CONCURRENCY) return { kind: "unchanged" as const, current: await result(client, row) };
    const token = randomUUID();
    const updated = (await client.query<InboxRow>(`UPDATE document_inbox_items SET status='READY_TO_FILE',filing_token=$3,filing_actor_id=$4,
      filing_attempt_count=filing_attempt_count+1,filing_queued_at=coalesce(filing_queued_at,now()),filing_started_at=now(),filing_heartbeat_at=now(),
      filing_lease_until=now()+$5*interval '1 second',filing_next_retry_at=NULL,filing_error_code=NULL,filing_stage='STARTING'
      WHERE organization_id=$1 AND id=$2 RETURNING *`, [context.organizationId, itemId, token, context.actorId, FILING_LEASE_SECONDS])).rows[0];
    return { kind: "claimed" as const, row: updated, connection, token };
  });
}

export async function retryDocumentFiling(context: TenantTransactionContext, input: z.input<typeof retryFilingSchema>) {
  const { itemId } = retryFilingSchema.parse(input);
  assertFilingWorkerScope(context, itemId);
  const job = await claim(context, itemId);
  if (job.kind === "unchanged") return job.current;
  const preparedConfig = job.connection.config_ciphertext;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new StorageError("STORAGE_FILING_TIMEOUT", "Filing attempt timed out.")), FILING_DEADLINE_MS);
  deadline.unref();
  let stage = "STARTING";
  let heartbeatRunning = false;
  async function heartbeat(nextStage?: string) {
    controller.signal.throwIfAborted();
    await filingTransaction(context, async (client) => {
      await assertStorageWrite(client, context);
      const { row, connection } = await loadInboxItem(client, context, itemId);
      if (row.filing_token !== job.token || !liveClaim(row) || connection.config_ciphertext !== preparedConfig) {
        throw new StorageError("STORAGE_FILING_LEASE_LOST", "Filing claim or connection changed.");
      }
      const processing = nextStage ? await itemProcessing(client, row) : null;
      const stored = processing ? await encryptStorageValue(client, row, "document_inbox_items", "processing_ciphertext", { ...processing, filingLastProgressAt: new Date().toISOString() }) : row.processing_ciphertext;
      await client.query(`UPDATE document_inbox_items SET filing_stage=coalesce($4,filing_stage),filing_heartbeat_at=now(),filing_lease_until=now()+$5*interval '1 second',processing_ciphertext=$6
        WHERE organization_id=$1 AND id=$2 AND filing_token=$3`, [context.organizationId, itemId, job.token, nextStage ?? null, FILING_LEASE_SECONDS, stored]);
    });
    if (nextStage) stage = nextStage;
  }
  const pulse = setInterval(() => {
    if (heartbeatRunning || controller.signal.aborted) return;
    heartbeatRunning = true;
    void heartbeat().catch((error: unknown) => controller.abort(error)).finally(() => { heartbeatRunning = false; });
  }, 20_000);
  pulse.unref();
  const aborted = new Promise<never>((_resolve, reject) => { controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }); });
  const log = (event: string, extra: Record<string, unknown> = {}) => console.info(JSON.stringify({ event, requestId: context.requestId, itemId, assetId: job.row.asset_id, attempt: job.row.filing_attempt_count, ...extra }));
  try {
    log("document.inbox.filing.started");
    return await Promise.race([(async () => {
      const preparedJob = await filingTransaction(context, async (client) => {
        const { row, connection } = await loadInboxItem(client, context, itemId);
        if (row.filing_token !== job.token || !liveClaim(row) || connection.config_ciphertext !== preparedConfig) throw new StorageError("STORAGE_FILING_LEASE_LOST", "Filing claim or connection changed.");
        const processing = await itemProcessing(client, row);
        if (!processing.name || !processing.folders) throw new StorageError("STORAGE_FILING_DESTINATION", "The saved archive destination is missing. Review the completed item.");
        return { processing, prepared: await prepareConnectedDrive(client, connection, "manage") };
      });
      const access = await resolvePreparedDrive(context, preparedJob.prepared);
      const drive = access.drive.withSignal?.(controller.signal, (status, providerRequestId) => {
        log("document.inbox.filing.provider", { stage, status, providerRequestId });
      }) ?? access.drive;
      const { location } = access;
      await heartbeat("PREPARING_ARCHIVE");
      let destination = location.archiveId;
      await assertStorageFolder(drive, location, destination, "archive");
      for (const segment of preparedJob.processing.folders!) {
        controller.signal.throwIfAborted();
        if (!segment || /[\\/\x00-\x1f]/.test(segment) || segment === "." || segment === "..") throw new StorageError("STORAGE_FOLDER_BOUNDARY", "The saved archive path is invalid.");
        const child = await drive.folder(destination, segment);
        assertDirectChild(await drive.file(child), destination);
        await assertStorageFolder(drive, location, child, "archive");
        destination = child;
      }
      await heartbeat("VERIFYING_SOURCE");
      const file = await drive.file(job.row.provider_file_id);
      const source = await filingTransaction(context, (client) => itemSourceMetadata(client, job.row));
      const alreadyFiled = file.parentId === destination && file.name === preparedJob.processing.name;
      if (!alreadyFiled && file.parentId !== (source.sourceFolderId ?? location.inboxId)) throw new StorageError("STORAGE_FILE_MOVED", "The document moved outside its expected inbox/archive location.");
      await assertStorageFolder(drive, location, file.parentId, alreadyFiled ? "archive" : "inbox");
      const verified = await validatedCloudBytes(drive, file);
      try {
        if (verified.sha256 !== job.row.sha256) throw new StorageError("STORAGE_CONTENT_CHANGED", "The original document changed after ingestion.");
        await assertStorageFolder(drive, location, file.parentId, alreadyFiled ? "archive" : "inbox");
        await assertStorageFolder(drive, location, destination, "archive");
        await heartbeat("MOVING");
        controller.signal.throwIfAborted();
        const filed = alreadyFiled ? file : await drive.move(verified.file, destination, preparedJob.processing.name!);
        assertDirectChild(filed, destination);
        if (filed.id !== file.id || filed.name !== preparedJob.processing.name) throw new StorageError("STORAGE_CONTENT_CHANGED", "The provider returned a different archived document.");
        await heartbeat("VERIFYING_ARCHIVE");
        const after = await drive.download(filed.id);
        try { if (createHash("sha256").update(after).digest("hex") !== job.row.sha256) throw new StorageError("STORAGE_CONTENT_CHANGED", "The archived document changed during filing."); }
        finally { after.fill(0); }
        assertDirectChild(await drive.file(filed.id), destination);
        await assertStorageFolder(drive, location, destination, "archive");
        controller.signal.throwIfAborted();
        const completed = await filingTransaction(context, async (client) => {
          await assertStorageWrite(client, context);
          const { row, connection } = await loadInboxItem(client, context, itemId);
          if (row.filing_token !== job.token || !liveClaim(row) || connection.config_ciphertext !== preparedConfig) throw new StorageError("STORAGE_FILING_LEASE_LOST", "Filing claim or connection changed.");
          const processing = await itemProcessing(client, row);
          const stored = await encryptStorageValue(client, row, "document_inbox_items", "processing_ciphertext", { ...processing, destinationId: destination, reason: undefined, filingLastProgressAt: new Date().toISOString() });
          const updated = (await client.query<InboxRow>(`UPDATE document_inbox_items SET status='FILED',content_version=$4,processing_ciphertext=$5,
            filing_token=NULL,filing_lease_until=NULL,filing_next_retry_at=NULL,filing_error_code=NULL,filing_stage=NULL,filing_heartbeat_at=now()
            WHERE organization_id=$1 AND id=$2 AND filing_token=$3 RETURNING *`, [context.organizationId, itemId, job.token, filed.version, stored])).rows[0];
          return result(client, updated);
        });
        log("document.inbox.filing.completed");
        return completed;
      } finally { verified.bytes.fill(0); }
    })(), aborted]);
  } catch (caught) {
    const error: unknown = controller.signal.aborted ? controller.signal.reason : caught;
    const code = error instanceof StorageError && /^STORAGE_[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : "STORAGE_FILING_RETRY_REQUIRED";
    const retryable = ["STORAGE_THROTTLED", "STORAGE_RETRYABLE", "STORAGE_PROVIDER_FAILED", "STORAGE_FILING_TIMEOUT", "STORAGE_FILING_RETRY_REQUIRED"].includes(code)
      && (job.row.filing_attempt_count ?? 1) < FILING_MAX_ATTEMPTS;
    const delay = filingRetrySeconds(job.row.filing_attempt_count ?? 1, error instanceof StorageError ? error.retryAfterSeconds : undefined);
    await filingTransaction(context, async (client) => {
      await assertStorageWrite(client, context);
      const { row } = await loadInboxItem(client, context, itemId);
      if (row.status === "FILED" || row.filing_token !== job.token) return;
      await client.query(`UPDATE document_inbox_items SET status=$4,filing_token=NULL,filing_lease_until=NULL,filing_stage=NULL,filing_error_code=$5,
        filing_next_retry_at=CASE WHEN $6 THEN now()+$7*interval '1 second' ELSE NULL END
        WHERE organization_id=$1 AND id=$2 AND filing_token=$3`, [context.organizationId, itemId, job.token, retryable ? "READY_TO_FILE" : "FILING_FAILED", code, retryable, delay]);
    }).catch((persistError: unknown) => {
      const sqlState = persistError && typeof persistError === "object" && "code" in persistError && typeof persistError.code === "string" && /^[0-9A-Z]{5}$/.test(persistError.code) ? persistError.code : null;
      console.warn(JSON.stringify({ event: "document.inbox.filing.status_write_failed", requestId: context.requestId, itemId, sqlState }));
    });
    const sqlState = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
    console.warn(JSON.stringify({ event: "document.inbox.filing.failed", sqlState, requestId: context.requestId, itemId, attempt: job.row.filing_attempt_count, errorCode: code, retryable, retryAfterSeconds: retryable ? delay : null }));
    throw error;
  } finally { clearInterval(pulse); clearTimeout(deadline); controller.abort(); }
}
