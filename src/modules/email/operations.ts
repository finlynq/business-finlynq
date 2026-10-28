import "server-only";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";
import { decryptEmailValue } from "./crypto";
import { clearEmailQuarantineSchema, retryEmailOperationSchema } from "./model";
import { retryInboundMessage } from "./inbound";
import { retryInvoiceDelivery } from "./outbound";
import { emailProviderReadiness } from "./configuration";

type ContextCommand = Readonly<{ context: TenantTransactionContext }>;
function withoutContext<T extends ContextCommand>(value: T): Omit<T, "context"> {
  const { context, ...command } = value;
  void context;
  return command;
}

async function assertOperationsRead(context: TenantTransactionContext, write = false) {
  return withTenantTransaction(context, async (client) => {
    if (write) {
      assertTenantWritesEnabled(context);
      await assertWritableOrganization(client, context);
    }
    await assertActorHasActivePermission(client, {
      organizationId: context.organizationId,
      actorId: context.actorId,
      permission: write ? PERMISSIONS.manageOrganizationSettings : PERMISSIONS.readOrganizationSettings,
    });
  });
}

type MessageSummaryRow = Readonly<{
  id: string; organization_id: string; alias_id: string; provider: string; provider_message_id: string;
  received_at: Date; envelope_ciphertext: string | null; key_version: number; status: string;
  retry_count: number; next_retry_at: Date | null; error_code: string | null; updated_at: Date;
  alias_label: string;
}>;

function maskAddress(address: string): string {
  const [local, domain] = address.split("@");
  return `${local?.slice(0, 2) ?? ""}•••@${domain ?? "unknown"}`;
}

export async function loadEmailOperations(context: TenantTransactionContext) {
  await assertOperationsRead(context);
  return withTenantTransaction(context, async (client) => {
    const [messageCounts, attachmentCounts, deliveryCounts, queueAge, settings, messages, deliveries, attachments] = await Promise.all([
      client.query<{ status: string; count: string }>(
        "SELECT status,count(*)::text AS count FROM inbound_email_messages WHERE organization_id=$1 GROUP BY status", [context.organizationId]),
      client.query<{ status: string; count: string }>(
        "SELECT status,count(*)::text AS count FROM inbound_email_attachments WHERE organization_id=$1 GROUP BY status", [context.organizationId]),
      client.query<{ status: string; count: string }>(
        "SELECT status,count(*)::text AS count FROM invoice_delivery_attempts WHERE organization_id=$1 GROUP BY status", [context.organizationId]),
      client.query<{ oldest_seconds: string | null; overdue_count: string; overdue_seconds: string | null }>(
        `SELECT extract(epoch FROM now()-min(created_at))::bigint::text AS oldest_seconds,
           count(*) FILTER (WHERE coalesce(next_retry_at,created_at)<now()
             AND (processing_expires_at IS NULL OR processing_expires_at<=now()))::text AS overdue_count,
           extract(epoch FROM now()-min(coalesce(next_retry_at,created_at)) FILTER
             (WHERE processing_expires_at IS NULL OR processing_expires_at<=now()))::bigint::text AS overdue_seconds
         FROM inbound_email_messages WHERE organization_id=$1 AND status IN ('STAGED','RETRY_PENDING')`, [context.organizationId]),
      client.query<{ outbound_enabled: boolean; auto_send_enabled: boolean; transient_retention_days: number; quarantine_retention_days: number; operation_retention_days: number }>(
        "SELECT outbound_enabled,auto_send_enabled,transient_retention_days,quarantine_retention_days,operation_retention_days FROM email_delivery_settings WHERE organization_id=$1", [context.organizationId]),
      client.query<MessageSummaryRow>(
        `SELECT message.*,alias.label AS alias_label FROM inbound_email_messages message
         JOIN email_ingestion_aliases alias ON alias.organization_id=message.organization_id AND alias.id=message.alias_id
         WHERE message.organization_id=$1 ORDER BY message.received_at DESC,message.id DESC LIMIT 50`, [context.organizationId]),
      client.query<{ id: string; source_document_id: string; status: string; failure_code: string | null; retry_count: number; created_at: Date; updated_at: Date }>(
        `SELECT id,source_document_id,status,failure_code,retry_count,created_at,updated_at
         FROM invoice_delivery_attempts WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50`, [context.organizationId]),
      client.query<{ id: string; message_id: string; status: string; quarantine_code: string | null;
        error_stage: string | null; attempt_count: number; next_retry_at: Date | null }>(
        `SELECT attachment.id,attachment.message_id,attachment.status,attachment.quarantine_code,
           attachment.error_stage,attachment.attempt_count,message.next_retry_at
         FROM inbound_email_attachments attachment
         JOIN (SELECT id,next_retry_at FROM inbound_email_messages WHERE organization_id=$1
           ORDER BY received_at DESC,id DESC LIMIT 50) message ON message.id=attachment.message_id
         WHERE attachment.organization_id=$1 ORDER BY attachment.message_id,attachment.id`, [context.organizationId]),
    ]);
    const messageDtos = [];
    for (const row of messages.rows) {
      let sender = "Transient envelope removed";
      let subject = "";
      if (row.envelope_ciphertext) {
        const envelope = z.object({ from: z.string(), subject: z.string() }).passthrough().parse(
          await decryptEmailValue(client, row, "inbound_email_messages", "envelope_ciphertext", row.envelope_ciphertext),
        );
        sender = maskAddress(envelope.from);
        subject = envelope.subject.slice(0, 160);
      }
      messageDtos.push({
        id: row.id, aliasId: row.alias_id, aliasLabel: row.alias_label, provider: row.provider,
        providerMessageId: row.provider_message_id, receivedAt: row.received_at.toISOString(),
        sender, subject, status: row.status, retryCount: row.retry_count,
        nextRetryAt: row.next_retry_at?.toISOString() ?? null, errorCode: row.error_code,
        updatedAt: row.updated_at.toISOString(),
        attachments: attachments.rows.filter((attachment) => attachment.message_id === row.id).map((attachment) => ({
          id: attachment.id, status: attachment.status, attemptCount: attachment.attempt_count,
          failureCode: attachment.quarantine_code, failureStage: attachment.error_stage,
          nextRetryAt: attachment.status === "RETRY_PENDING" ? attachment.next_retry_at?.toISOString() ?? null : null,
        })),
      });
    }
    const counts = (rows: readonly { status: string; count: string }[]) => Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    return {
      readiness: emailProviderReadiness(),
      policy: settings.rows[0] ?? { outbound_enabled: false, auto_send_enabled: false, transient_retention_days: 30, quarantine_retention_days: 30, operation_retention_days: 90 },
      metrics: {
        inboundMessages: counts(messageCounts.rows),
        attachments: counts(attachmentCounts.rows),
        deliveries: counts(deliveryCounts.rows),
        oldestQueueSeconds: Number(queueAge.rows[0]?.oldest_seconds ?? "0"),
        overdueRetryCount: Number(queueAge.rows[0]?.overdue_count ?? "0"),
        oldestOverdueRetrySeconds: Math.max(0, Number(queueAge.rows[0]?.overdue_seconds ?? "0")),
        retryAlert: Number(queueAge.rows[0]?.overdue_seconds ?? "0") > 300,
      },
      messages: messageDtos,
      deliveries: deliveries.rows.map((row) => ({
        id: row.id, sourceDocumentId: row.source_document_id, status: row.status,
        failureCode: row.failure_code, retryCount: row.retry_count,
        createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
      })),
    };
  });
}

export async function retryEmailOperation(unparsed: ContextCommand & z.input<typeof retryEmailOperationSchema>) {
  const command = retryEmailOperationSchema.parse(withoutContext(unparsed));
  await assertOperationsRead({ ...unparsed.context, reason: command.reason }, true);
  if (command.kind === "INBOUND_MESSAGE") return retryInboundMessage(unparsed.context, command.id);
  if (command.kind === "DELIVERY") return retryInvoiceDelivery(unparsed.context, command.id);
  const loaded = await withTenantTransaction(unparsed.context, async (client) => {
    const attachment = (await client.query<{ id: string; status: string; message_id: string }>(
      "SELECT id,status,message_id FROM inbound_email_attachments WHERE organization_id=$1 AND id=$2 FOR UPDATE",
      [unparsed.context.organizationId, command.id],
    )).rows[0];
    if (!attachment || attachment.status !== "RETRY_PENDING") throw new Error("Only a retry-pending attachment can be retried");
    const alias = (await client.query<{ id: string; connection_id: string | null }>(
      `SELECT alias.id,alias.connection_id FROM inbound_email_messages message
       JOIN email_ingestion_aliases alias ON alias.organization_id=message.organization_id AND alias.id=message.alias_id
       WHERE message.organization_id=$1 AND message.id=$2`, [unparsed.context.organizationId, attachment.message_id],
    )).rows[0];
    if (!alias) throw new Error("Inbound email alias is unavailable");
    return { attachment, alias };
  });
  return retryInboundMessage(unparsed.context, loaded.attachment.message_id, { attachmentId: loaded.attachment.id });
}

export async function clearEmailQuarantine(unparsed: ContextCommand & z.input<typeof clearEmailQuarantineSchema>) {
  const command = clearEmailQuarantineSchema.parse(withoutContext(unparsed));
  await assertOperationsRead({ ...unparsed.context, reason: command.reason }, true);
  const loaded = await withTenantTransaction(unparsed.context, async (client) => {
    const attachment = (await client.query<{ id: string; status: string; quarantine_code: string | null; message_id: string }>(
      "SELECT id,status,quarantine_code,message_id FROM inbound_email_attachments WHERE organization_id=$1 AND id=$2 FOR UPDATE",
      [unparsed.context.organizationId, command.attachmentId],
    )).rows[0];
    if (!attachment || attachment.status !== "QUARANTINED") throw new Error("Attachment is not quarantined");
    if (["ATTACHMENT_TYPE", "ATTACHMENT_SIZE", "ATTACHMENT_CORRUPT", "ATTACHMENT_ENCRYPTED"].includes(attachment.quarantine_code ?? "")) {
      throw new Error("Unsupported, corrupt, oversize, or encrypted content cannot be cleared into processing");
    }
    const alias = (await client.query<{ id: string; connection_id: string | null }>(
      `SELECT alias.id,alias.connection_id FROM inbound_email_messages message
       JOIN email_ingestion_aliases alias ON alias.organization_id=message.organization_id AND alias.id=message.alias_id
       WHERE message.organization_id=$1 AND message.id=$2`, [unparsed.context.organizationId, attachment.message_id],
    )).rows[0];
    if (!alias) throw new Error("Inbound email alias is unavailable");
    await client.query(
      "UPDATE inbound_email_attachments SET status='RETRY_PENDING',quarantine_code=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2",
      [unparsed.context.organizationId, attachment.id],
    );
    await client.query(
      `UPDATE inbound_email_messages SET status='RETRY_PENDING',next_retry_at=now(),error_code=NULL,updated_at=now()
       WHERE organization_id=$1 AND id=$2 AND status IN ('NEEDS_REVIEW','QUARANTINED')`,
      [unparsed.context.organizationId, attachment.message_id],
    );
    await client.query(
      `INSERT INTO email_operation_events(organization_id,category,event_type,aggregate_id,outcome,safe_details)
       VALUES ($1,'QUARANTINE','CLEARED',$2,'AUTHORIZED',$3)`,
      [unparsed.context.organizationId, attachment.id, { reason: command.reason }],
    );
    return { attachment, alias };
  });
  return retryInboundMessage(unparsed.context, loaded.attachment.message_id, { attachmentId: loaded.attachment.id });
}

export async function runEmailRetention(context: TenantTransactionContext) {
  await assertOperationsRead(context, true);
  return withTenantTransaction(context, async (client) => {
    const settings = (await client.query<{
      transient_retention_days: number; quarantine_retention_days: number; operation_retention_days: number;
    }>("SELECT transient_retention_days,quarantine_retention_days,operation_retention_days FROM email_delivery_settings WHERE organization_id=$1", [context.organizationId])).rows[0]
      ?? { transient_retention_days: 30, quarantine_retention_days: 30, operation_retention_days: 90 };
    const messages = await client.query(
      `UPDATE inbound_email_messages SET envelope_ciphertext=NULL,updated_at=now()
       WHERE organization_id=$1 AND envelope_ciphertext IS NOT NULL
         AND created_at < now()-make_interval(days=>$2) AND status NOT IN ('STAGED','RETRY_PENDING') RETURNING id`,
      [context.organizationId, settings.transient_retention_days],
    );
    const attachments = await client.query(
      `UPDATE inbound_email_attachments attachment SET content_ciphertext=NULL,updated_at=now()
       FROM inbound_email_messages message
       WHERE attachment.organization_id=$1 AND message.organization_id=attachment.organization_id AND message.id=attachment.message_id
         AND attachment.content_ciphertext IS NOT NULL
         AND message.created_at < now()-make_interval(days=>CASE WHEN attachment.status='QUARANTINED' THEN $2 ELSE $3 END)
         AND attachment.status NOT IN ('STAGED','RETRY_PENDING') RETURNING attachment.id`,
      [context.organizationId, settings.quarantine_retention_days, settings.transient_retention_days],
    );
    const operations = await client.query(
      `UPDATE email_operation_events SET safe_details='{}'::jsonb
       WHERE organization_id=$1 AND safe_details<>'{}'::jsonb
         AND occurred_at < now()-make_interval(days=>$2) RETURNING id`,
      [context.organizationId, settings.operation_retention_days],
    );
    return { messagesMinimized: messages.rowCount, attachmentsMinimized: attachments.rowCount, operationDetailsMinimized: operations.rowCount };
  });
}
