import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { queryDatabase, withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { uploadInboxDocument } from "@/modules/document-storage/upload";
import { assertWritableOrganization } from "@/modules/workspace/write-policy";
import { attachmentSafety, groupAccountingAttachments } from "./policy";
import { activeEmailKeyVersion, decryptEmailValue, encryptEmailValue } from "./crypto";
import { inboundProviderMessageSchema, normalizeEmailAddress, type InboundProviderMessage } from "./model";

type ResolvedAlias = Readonly<{
  organization_id: string;
  alias_id: string;
  actor_id: string;
  legal_entity_id: string | null;
  connection_id: string | null;
  purpose: "PAYABLES" | "RECEIVABLES" | "GENERAL";
  hourly_limit: number;
  max_payload_bytes: number;
}>;

type MessageRow = Readonly<{
  id: string; organization_id: string; alias_id: string; provider: "SELF_SMTP" | "RESEND";
  provider_event_id: string; provider_message_id: string; received_at: Date;
  envelope_ciphertext: string | null; key_version: number; routing_result: string; status: string;
  retry_count: number; next_retry_at: Date | null; error_code: string | null;
}>;
type AttachmentRow = Readonly<{
  id: string; organization_id: string; message_id: string; attachment_key: string;
  filename_ciphertext: string; content_ciphertext: string | null; key_version: number;
  mime_type: string; byte_size: number; sha256: string; page_count: number | null;
  evidence_purpose: "INVOICE" | "RECEIPT" | "SUPPORTING"; status: string;
  quarantine_code: string | null; inbox_item_id: string | null; evidence_asset_id: string | null;
}>;

export type InboundIngestResult = Readonly<{
  accepted: true;
  routedRecipients: number;
  ignoredRecipients: number;
  replays: number;
  retryPending: boolean;
}>;

function digestAddress(address: string): string {
  return createHash("sha256").update(normalizeEmailAddress(address), "utf8").digest("hex");
}

async function resolveAlias(recipient: string): Promise<ResolvedAlias | null> {
  const result = await queryDatabase<ResolvedAlias>(
    "SELECT * FROM app.resolve_inbound_email_alias($1)",
    [digestAddress(recipient)],
  );
  return result.rows[0] ?? null;
}

function workerContext(alias: ResolvedAlias, message: InboundProviderMessage): TenantTransactionContext {
  return {
    organizationId: alias.organization_id,
    actorId: alias.actor_id,
    sessionMode: "real",
    requestId: `email-inbound:${message.provider}:${message.eventId}:${alias.alias_id}`.slice(0, 200),
    authMethod: "self-smtp-webhook",
    sourceSurface: "WORKER",
    reason: "Verified inbound accounting email",
  };
}

async function recordOperation(
  context: TenantTransactionContext,
  category: string,
  eventType: string,
  aggregateId: string | null,
  outcome: string,
  safeDetails: Record<string, unknown> = {},
) {
  await withTenantTransaction(context, async (client) => {
    await client.query(
      `INSERT INTO email_operation_events(organization_id,category,event_type,aggregate_id,outcome,safe_details)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [context.organizationId, category, eventType, aggregateId, outcome, safeDetails],
    );
  });
}

async function stageForAlias(alias: ResolvedAlias, message: InboundProviderMessage) {
  const context = workerContext(alias, message);
  return withTenantTransaction(context, async (client) => {
    await assertWritableOrganization(client, context);
    const currentAlias = await client.query(
      `SELECT 1
       FROM email_ingestion_aliases selected_alias
       WHERE selected_alias.organization_id=$1 AND selected_alias.id=$2 AND selected_alias.status='ACTIVE'
         AND app.lock_active_email_membership(selected_alias.owner_membership_id)
       FOR UPDATE OF selected_alias`,
      [alias.organization_id, alias.alias_id],
    );
    if (!currentAlias.rows[0]) return { context, row: null, attachments: [], replay: false, ignored: true };
    const existing = (await client.query<MessageRow>(
      `SELECT * FROM inbound_email_messages
       WHERE organization_id=$1 AND alias_id=$2 AND provider=$3
         AND (provider_event_id=$4 OR provider_message_id=$5)`,
      [alias.organization_id, alias.alias_id, message.provider, message.eventId, message.messageId],
    )).rows[0];
    if (existing) return { context, row: existing, attachments: [], replay: true, ignored: false };

    const recent = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inbound_email_messages
       WHERE organization_id=$1 AND alias_id=$2 AND created_at > now()-interval '1 hour'`,
      [alias.organization_id, alias.alias_id],
    );
    const rateLimited = Number(recent.rows[0]?.count ?? "0") >= alias.hourly_limit;
    const payloadBytes = Buffer.byteLength(message.text ?? "", "utf8")
      + Buffer.byteLength(message.html ?? "", "utf8")
      + message.attachments.reduce((sum, attachment) => sum
        + (attachment.declaredSize ?? attachment.content?.length ?? 0), 0);
    const oversize = payloadBytes > alias.max_payload_bytes;
    const attachmentFlood = message.attachmentOverflow || message.attachments.length > 20;
    const id = randomUUID();
    const scope = { id, organization_id: alias.organization_id, key_version: await activeEmailKeyVersion(client, alias.organization_id) };
    const envelope = await encryptEmailValue(client, scope, "inbound_email_messages", "envelope_ciphertext", {
      from: message.from,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    // Commit retryable state before downstream I/O. A crash after this
    // transaction must leave work that the normal retry action can resume.
    const initialStatus = rateLimited || oversize || attachmentFlood ? "QUARANTINED" : "RETRY_PENDING";
    const errorCode = rateLimited ? "RATE_LIMITED" : oversize ? "PAYLOAD_TOO_LARGE"
      : attachmentFlood ? "TOO_MANY_ATTACHMENTS" : null;
    const row = (await client.query<MessageRow>(
      `INSERT INTO inbound_email_messages
       (id,organization_id,alias_id,provider,provider_event_id,provider_message_id,received_at,sender_auth,envelope_ciphertext,key_version,routing_result,status,error_code,next_retry_at,transient_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ROUTED',$11,$12,
         CASE WHEN $11='RETRY_PENDING' THEN now()+interval '1 minute' ELSE NULL END,now()+interval '30 days') RETURNING *`,
      [id, alias.organization_id, alias.alias_id, message.provider, message.eventId, message.messageId,
        message.receivedAt, message.senderAuth, envelope, scope.key_version, initialStatus, errorCode],
    )).rows[0];
    // Retain even quarantined attachment bytes before acknowledging the relay.
    const groups = groupAccountingAttachments(message.attachments.map((item) => ({ id: item.id, filename: item.filename, mimeType: item.mimeType })));
    const purpose = new Map<string, "INVOICE" | "RECEIPT">();
    for (const group of groups) {
      purpose.set(group.primary.id, "INVOICE");
      group.supporting.forEach((item) => purpose.set(item.id, "RECEIPT"));
    }
    const stored: AttachmentRow[] = [];
    for (const [index, attachment] of message.attachments.entries()) {
      const attachmentId = randomUUID();
      const attachmentScope = { id: attachmentId, organization_id: alias.organization_id, key_version: scope.key_version };
      const declaredSize = attachment.declaredSize ?? attachment.content?.length ?? 0;
      const safety = errorCode
        ? { allowed: false as const, code: errorCode, reason: "Message quarantined by intake policy" }
        : attachment.mimeType !== "application/pdf"
        ? { allowed: false as const, code: "ATTACHMENT_TYPE", reason: "Only PDF email attachments are currently supported" }
        : declaredSize > 2 * 1024 * 1024
          ? { allowed: false as const, code: "ATTACHMENT_SIZE", reason: "The attachment size is not supported" }
        : attachmentSafety({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          bytes: attachment.content ?? Buffer.alloc(0),
          messageAttachmentCount: message.attachments.length,
          maximumBytes: 2 * 1024 * 1024,
        });
      const contentBytes = attachment.content ?? Buffer.alloc(0);
      const sha256 = createHash("sha256").update(contentBytes).digest("hex");
      const filename = await encryptEmailValue(client, attachmentScope, "inbound_email_attachments", "filename_ciphertext", attachment.filename);
      const content = attachment.content
        ? await encryptEmailValue(client, attachmentScope, "inbound_email_attachments", "content_ciphertext", attachment.content.toString("base64"))
        : null;
      stored.push((await client.query<AttachmentRow>(
        `INSERT INTO inbound_email_attachments
         (id,organization_id,message_id,attachment_key,filename_ciphertext,content_ciphertext,key_version,mime_type,byte_size,sha256,evidence_purpose,status,quarantine_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [attachmentId, alias.organization_id, id, `${index}:${attachment.id}`, filename, content,
          scope.key_version, attachment.mimeType, declaredSize, sha256,
          purpose.get(attachment.id) ?? "SUPPORTING", safety.allowed ? "RETRY_PENDING" : "QUARANTINED",
          safety.allowed ? null : safety.code],
      )).rows[0]);
    }
    return { context, row, attachments: stored, replay: false, ignored: false };
  });
}

async function attachmentContent(context: TenantTransactionContext, attachmentId: string) {
  return withTenantTransaction(context, async (client) => {
    const row = (await client.query<AttachmentRow>(
      "SELECT * FROM inbound_email_attachments WHERE organization_id=$1 AND id=$2 FOR SHARE",
      [context.organizationId, attachmentId],
    )).rows[0];
    if (!row || !row.content_ciphertext) throw new Error("Staged email attachment content is unavailable");
    const filename = z.string().parse(await decryptEmailValue(client, row, "inbound_email_attachments", "filename_ciphertext", row.filename_ciphertext));
    const base64 = z.string().parse(await decryptEmailValue(client, row, "inbound_email_attachments", "content_ciphertext", row.content_ciphertext));
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length !== row.byte_size || createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
      bytes.fill(0);
      throw new Error("Staged email attachment integrity check failed");
    }
    return { row, filename, bytes };
  });
}

async function finishAttachment(
  context: TenantTransactionContext,
  attachmentId: string,
  status: "INBOXED" | "RETRY_PENDING" | "QUARANTINED",
  input: { inboxItemId?: string; errorCode?: string } = {},
) {
  await withTenantTransaction(context, async (client) => {
    await client.query(
      `UPDATE inbound_email_attachments SET status=$3,inbox_item_id=coalesce($4,inbox_item_id),quarantine_code=$5,updated_at=now()
       WHERE organization_id=$1 AND id=$2`,
      [context.organizationId, attachmentId, status, input.inboxItemId ?? null, input.errorCode ?? null],
    );
  });
}

export async function processStagedInboundAttachment(
  context: TenantTransactionContext,
  alias: Pick<ResolvedAlias, "alias_id" | "connection_id">,
  attachmentId: string,
) {
  if (!alias.connection_id) {
    await finishAttachment(context, attachmentId, "RETRY_PENDING", { errorCode: "STORAGE_NOT_CONFIGURED" });
    return { status: "RETRY_PENDING" as const };
  }
  const staged = await attachmentContent(context, attachmentId);
  try {
    const uploaded = await uploadInboxDocument(context, {
      connectionId: alias.connection_id,
      filename: staged.filename,
      mimeType: "application/pdf",
      byteSize: staged.row.byte_size,
      sha256: staged.row.sha256,
      contentBase64: staged.bytes.toString("base64"),
      idempotencyKey: `email:${staged.row.message_id}:${staged.row.attachment_key}`,
    });
    await finishAttachment(context, attachmentId, "INBOXED", { inboxItemId: uploaded.item.id });
    return { status: "INBOXED" as const, inboxItemId: uploaded.item.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email attachment processing failed";
    const quarantine = /malware|password|encrypted|unsupported|invalid evidence/i.test(message);
    await finishAttachment(context, attachmentId, quarantine ? "QUARANTINED" : "RETRY_PENDING", {
      errorCode: quarantine ? "ATTACHMENT_SECURITY_REJECTED" : "STORAGE_RETRYABLE",
    });
    return { status: quarantine ? "QUARANTINED" as const : "RETRY_PENDING" as const };
  } finally {
    staged.bytes.fill(0);
  }
}

async function finishMessage(context: TenantTransactionContext, messageId: string) {
  return withTenantTransaction(context, async (client) => {
    const counts = await client.query<{ status: string; count: string }>(
      `SELECT status,count(*)::text AS count FROM inbound_email_attachments
       WHERE organization_id=$1 AND message_id=$2 GROUP BY status`,
      [context.organizationId, messageId],
    );
    const byStatus = new Map(counts.rows.map((row) => [row.status, Number(row.count)]));
    const status = byStatus.get("RETRY_PENDING")
      ? "RETRY_PENDING"
      : byStatus.get("QUARANTINED")
        ? "NEEDS_REVIEW"
        : byStatus.get("INBOXED")
          ? "READY"
          : "QUARANTINED";
    await client.query(
      `UPDATE inbound_email_messages SET status=$3,error_code=$4,
         next_retry_at=CASE WHEN $3='RETRY_PENDING' THEN now()+interval '1 minute' ELSE NULL END,updated_at=now()
       WHERE organization_id=$1 AND id=$2`,
      [context.organizationId, messageId, status, status === "QUARANTINED" ? "NO_SUPPORTED_ATTACHMENTS" : null],
    );
    return status;
  });
}

export async function ingestInboundEmail(unparsed: InboundProviderMessage): Promise<InboundIngestResult> {
  const message = inboundProviderMessageSchema.parse(unparsed);
  const recipients = [...new Set(message.to.map(normalizeEmailAddress))];
  const aliases = await Promise.all(recipients.map(resolveAlias));
  let routedRecipients = 0;
  let ignoredRecipients = 0;
  let replays = 0;
  let retryPending = false;
  for (let index = 0; index < recipients.length; index += 1) {
    const alias = aliases[index];
    if (!alias) { ignoredRecipients += 1; continue; }
    const staged = await stageForAlias(alias, message);
    if (staged.ignored || !staged.row) { ignoredRecipients += 1; continue; }
    routedRecipients += 1;
    if (staged.replay) {
      replays += 1;
      retryPending ||= staged.row.status === "RETRY_PENDING";
      continue;
    }
    if (staged.row.status === "QUARANTINED") {
      await recordOperation(staged.context, "INBOUND", "MESSAGE_INGESTED", staged.row.id, "QUARANTINED", {
        attachmentCount: staged.attachments.length,
        quarantineCode: staged.row.error_code,
        replay: false,
      });
      continue;
    }
    const results = await Promise.all(staged.attachments
      .filter((attachment) => attachment.status === "RETRY_PENDING")
      .map((attachment) => processStagedInboundAttachment(staged.context, alias, attachment.id)));
    const status = await finishMessage(staged.context, staged.row.id);
    retryPending ||= status === "RETRY_PENDING" || results.some((result) => result.status === "RETRY_PENDING");
    await recordOperation(staged.context, "INBOUND", "MESSAGE_INGESTED", staged.row.id, status, {
      attachmentCount: staged.attachments.length,
      replay: false,
    });
  }
  return { accepted: true, routedRecipients, ignoredRecipients, replays, retryPending };
}

export async function loadInboundMessageForRetry(context: TenantTransactionContext, messageId: string) {
  return withTenantTransaction(context, async (client) => {
    const row = (await client.query<MessageRow>(
      "SELECT * FROM inbound_email_messages WHERE organization_id=$1 AND id=$2 FOR UPDATE",
      [context.organizationId, z.uuid().parse(messageId)],
    )).rows[0];
    if (!row) throw new Error("Inbound email message is unavailable");
    if (row.status !== "RETRY_PENDING") throw new Error("Only a retry-pending inbound message can be retried");
    if (row.retry_count >= 5) throw new Error("Inbound email retry limit has been reached");
    const alias = (await client.query<{ id: string; connection_id: string | null }>(
      "SELECT id,connection_id FROM email_ingestion_aliases WHERE organization_id=$1 AND id=$2",
      [context.organizationId, row.alias_id],
    )).rows[0];
    const attachments = await client.query<AttachmentRow>(
      "SELECT * FROM inbound_email_attachments WHERE organization_id=$1 AND message_id=$2 AND status='RETRY_PENDING' ORDER BY id",
      [context.organizationId, row.id],
    );
    await client.query(
      "UPDATE inbound_email_messages SET retry_count=retry_count+1,next_retry_at=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2",
      [context.organizationId, row.id],
    );
    return { row, alias, attachments: attachments.rows };
  });
}

export async function retryInboundMessage(context: TenantTransactionContext, messageId: string) {
  const loaded = await loadInboundMessageForRetry(context, messageId);
  if (!loaded.alias) throw new Error("Inbound email alias is unavailable");
  const results = [];
  for (const attachment of loaded.attachments) {
    results.push(await processStagedInboundAttachment(context, {
      alias_id: loaded.alias.id,
      connection_id: loaded.alias.connection_id,
    }, attachment.id));
  }
  const status = await finishMessage(context, loaded.row.id);
  return { messageId: loaded.row.id, status, results };
}
