import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { completeInboxDocument, reviewInboxDocument } from "@/modules/document-storage/inbox";
import { getCurrentSubledgerDocument, issueBusinessDocument } from "@/modules/subledger/ar-ap-service";
import { canonicalHash } from "@/modules/subledger/document-model";
import { decryptEmailValue, activeEmailKeyVersion, encryptEmailValue } from "./crypto";
import { processEmailPayableSchema } from "./model";
import { evaluateBookingPolicy, type BookingDecision, type BookingRule } from "./policy";

type ContextCommand = Readonly<{ context: TenantTransactionContext }>;
function withoutContext<T extends ContextCommand>(value: T): Omit<T, "context"> {
  const { context, ...command } = value;
  void context;
  return command;
}

type EvaluationRow = Readonly<{
  id: string; organization_id: string; inbox_item_id: string; message_id: string;
  rule_id: string | null; rule_version: number | null; facts_ciphertext: string; key_version: number;
  outcome: string; reason: string; source_document_id: string | null;
  idempotency_key: string; command_hash: string; created_at: Date;
}>;

export async function processEmailPayable(unparsed: ContextCommand & z.input<typeof processEmailPayableSchema>) {
  const command = processEmailPayableSchema.parse(withoutContext(unparsed));
  const idempotencyKey = `email-booking:${canonicalHash(command.idempotencyKey)}`;
  const commandHash = canonicalHash(command);
  const evaluated = await withTenantTransaction({ ...unparsed.context, reason: command.reason }, async (client) => {
    const replay = (await client.query<EvaluationRow>(
      "SELECT * FROM email_booking_evaluations WHERE organization_id=$1 AND idempotency_key=$2",
      [unparsed.context.organizationId, idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error("Email booking idempotency key was already used differently");
      if (replay.source_document_id) {
        return { evaluation: replay, replay: true, decision: null, sender: null };
      }
    }
    const source = (await client.query<{
      message_id: string; envelope_ciphertext: string | null; organization_id: string;
      key_version: number; status: string; sender_auth: unknown;
    }>(
      `SELECT attachment.message_id,message.envelope_ciphertext,message.organization_id,message.key_version,
          message.sender_auth,attachment.status
       FROM inbound_email_attachments attachment
       JOIN inbound_email_messages message ON message.organization_id=attachment.organization_id AND message.id=attachment.message_id
       WHERE attachment.organization_id=$1 AND attachment.inbox_item_id=$2`,
      [unparsed.context.organizationId, command.inboxItemId],
    )).rows[0];
    if (!source || !source.envelope_ciphertext || source.status !== "INBOXED") {
      throw new Error("The claimed inbox item is not backed by a ready EMAIL attachment");
    }
    const envelope = z.object({ from: z.string() }).passthrough().parse(await decryptEmailValue(
      client, { ...source, id: source.message_id }, "inbound_email_messages", "envelope_ciphertext", source.envelope_ciphertext,
    ));
    if (replay) {
      const outcome = z.enum(["REVIEW", "CREATE_DRAFT", "AUTO_POST"]).parse(replay.outcome);
      const decision: BookingDecision = {
        outcome,
        reason: replay.reason,
        ...(replay.rule_id ? { ruleId: replay.rule_id } : {}),
        ...(replay.rule_version ? { ruleVersion: replay.rule_version } : {}),
      };
      return { evaluation: replay, replay: true, decision, sender: envelope.from };
    }
    const rules = (await client.query<BookingRule>(
      `SELECT id,version,name,priority,mode,conditions,action FROM email_booking_rules
       WHERE organization_id=$1 AND active ORDER BY priority,id`, [unparsed.context.organizationId],
    )).rows;
    const tenantPosting = command.draft ? (await client.query<{ manual_posting_mode: string }>(
      "SELECT manual_posting_mode FROM ledger_posting_policies WHERE organization_id=$1 AND ledger_id=$2 ORDER BY version DESC LIMIT 1",
      [unparsed.context.organizationId, command.draft.ledgerId],
    )).rows[0] : null;
    const decision = evaluateBookingPolicy({
      facts: command.facts,
      sender: envelope.from,
      senderAuth: z.object({ dkim: z.string(), spf: z.string(), dmarc: z.string() }).passthrough().parse(source.sender_auth),
      rules,
      tenantAllowsAutoPost: tenantPosting?.manual_posting_mode === "AUTO_POST",
    });
    if (decision.outcome !== "REVIEW" && !command.draft) throw new Error("A complete supplier-bill draft is required for automated booking");
    if (command.draft) {
      if (command.draft.legalEntityId !== command.facts.legalEntityId
          || command.draft.partyAccountId !== command.facts.supplierPartyAccountId
          || command.draft.sourceNumber !== command.facts.sourceNumber
          || command.draft.documentDate !== command.facts.documentDate
          || command.draft.dueOn !== command.facts.dueDate
          || command.draft.currency !== command.facts.currency) {
        throw new Error("Draft accounting facts must exactly match the reviewed email extraction");
      }
    }
    const id = randomUUID();
    const scope = { id, organization_id: unparsed.context.organizationId, key_version: await activeEmailKeyVersion(client, unparsed.context.organizationId) };
    const encryptedFacts = await encryptEmailValue(client, scope, "email_booking_evaluations", "facts_ciphertext", command.facts);
    const evaluation = (await client.query<EvaluationRow>(
      `INSERT INTO email_booking_evaluations
       (id,organization_id,inbox_item_id,message_id,rule_id,rule_version,facts_ciphertext,key_version,outcome,reason,idempotency_key,command_hash,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, unparsed.context.organizationId, command.inboxItemId, source.message_id,
        decision.ruleId ?? null, decision.ruleVersion ?? null, encryptedFacts, scope.key_version,
        decision.outcome, decision.reason, idempotencyKey, commandHash, unparsed.context.actorId],
    )).rows[0];
    return { evaluation, replay: false, decision, sender: envelope.from };
  });

  if (evaluated.replay && !evaluated.decision) {
    return {
      evaluationId: evaluated.evaluation.id,
      outcome: evaluated.evaluation.outcome,
      reason: evaluated.evaluation.reason,
      sourceDocumentId: evaluated.evaluation.source_document_id,
      idempotentReplay: true,
    };
  }
  const decision = evaluated.decision!;
  if (decision.outcome === "REVIEW") {
    await reviewInboxDocument(unparsed.context, {
      itemId: command.inboxItemId,
      claimId: command.claimId,
      reason: `${command.reason}: ${decision.reason}`.slice(0, 500),
    });
    return { evaluationId: evaluated.evaluation.id, outcome: decision.outcome, reason: decision.reason, sourceDocumentId: null, idempotentReplay: evaluated.replay };
  }

  const draft = command.draft!;
  const completed = await completeInboxDocument(unparsed.context, {
    itemId: command.inboxItemId,
    claimId: command.claimId,
    sha256: command.sha256,
    metadata: {
      documentType: "PURCHASE_INVOICE",
      documentDate: command.facts.documentDate!,
      counterparty: evaluated.sender!,
      reference: command.facts.sourceNumber!,
      currency: command.facts.currency!,
      total: command.facts.total!,
    },
    action: { type: "CREATE_DRAFT", draft: { ...draft, kind: "SUPPLIER_BILL" } },
    reason: command.reason,
  });
  let current = await getCurrentSubledgerDocument({
    context: unparsed.context,
    ownerModule: "payables",
    sourceType: "payables.supplier-bill",
    sourceNumber: draft.sourceNumber,
  });
  if (!current) throw new Error("The email-created supplier bill is unavailable");
  if (decision.outcome === "AUTO_POST" && current.status === "DRAFT") {
    const issued = await issueBusinessDocument({
      context: unparsed.context,
      kind: "SUPPLIER_BILL",
      sourceNumber: current.sourceNumber,
      expectedVersion: current.version,
      idempotencyKey: `email-auto-post:${evaluated.evaluation.id}`,
    });
    current = issued.document;
  }
  await withTenantTransaction(unparsed.context, async (client) => {
    await client.query(
      "UPDATE email_booking_evaluations SET source_document_id=$3 WHERE organization_id=$1 AND id=$2 AND source_document_id IS NULL",
      [unparsed.context.organizationId, evaluated.evaluation.id, current!.id],
    );
  });
  return {
    evaluationId: evaluated.evaluation.id,
    outcome: decision.outcome,
    reason: decision.reason,
    sourceDocumentId: current.id,
    sourceDocumentStatus: current.status,
    filingPending: "filingPending" in completed ? completed.filingPending : false,
    idempotentReplay: evaluated.replay,
  };
}
