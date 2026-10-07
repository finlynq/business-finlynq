import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { evaluateJournalWorkflow, JournalWorkflowError, readJournalWorkflowFacts, type JournalWorkflowAction } from "./journal-workflow-eligibility";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { assertActorHasActivePermission, type ActorPermissionRequest } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";

export { JournalWorkflowError } from "./journal-workflow-eligibility";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/i);

export const submitSchema = z.object({
  journalId: z.uuid(),
  expectedContentHash: hashSchema.optional(),
}).strict();

export const approveSchema = z.object({
  journalId: z.uuid(),
  expectedContentHash: hashSchema,
  expectedApprovalVersion: z.number().int().positive(),
  reason: z.string().trim().min(5).max(500),
}).strict();

async function assertWorkflowPermission(client: PoolClient, request: ActorPermissionRequest) {
  try {
    await assertActorHasActivePermission(client, request);
  } catch (error) {
    if (error instanceof Error && error.message === "Posting permission is required for an active organization member") {
      throw new JournalWorkflowError("MISSING_PERMISSION");
    }
    throw error;
  }
}

async function assertWorkflowAction(client: PoolClient, context: TenantTransactionContext, journalId: string, action: JournalWorkflowAction) {
  const journal = (await readJournalWorkflowFacts(client, context.organizationId, [journalId]))[0];
  if (!journal) throw new JournalWorkflowError("INVALID_STATE", "Journal was not found in the authorized organization.");
  // Permission and organization activation were checked within this same transaction.
  const decision = evaluateJournalWorkflow(journal, {
    actorId: context.actorId, canWrite: true,
    permissions: new Set([action === "approve" || action === "reject" ? PERMISSIONS.approveJournal : PERMISSIONS.submitJournal]),
  }).actions[action];
  if (!decision.allowed) throw new JournalWorkflowError(decision.reasonCode!);
}

export async function submitJournalForApproval(input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof submitSchema>) {
  const { context, ...unparsedCommand } = input;
  assertTenantWritesEnabled(context);
  const command = submitSchema.parse(unparsedCommand);
  return withTenantTransaction(context, async (client) => {
    await assertWritableOrganization(client, context);
    await assertWorkflowPermission(client, {
      organizationId: context.organizationId,
      actorId: context.actorId,
      permission: PERMISSIONS.submitJournal,
    });
    const current = await client.query<{
      id: string;
      status: string;
      content_hash: string | null;
      approval_version: number | null;
      owner_module: string;
      journal_type_key: string;
    }>(
      `SELECT entry.id, entry.status, entry.content_hash, entry.approval_version,
         type.owner_module, entry.journal_type_key
       FROM journal_entries entry
       JOIN journal_type_definitions type
         ON type.id = entry.journal_type_definition_id
        AND type.key = entry.journal_type_key
        AND type.version = entry.journal_type_version
       WHERE entry.organization_id = $1 AND entry.id = $2
       FOR UPDATE OF entry`,
      [context.organizationId, command.journalId],
    );
    const journal = current.rows[0];
    if (!journal || journal.owner_module !== "ledger" || journal.journal_type_key !== "ledger.manual") {
      throw new JournalWorkflowError("POLICY_RESTRICTION");
    }
    if (journal.status === "SUBMITTED") {
      if (!journal.content_hash || !journal.approval_version ||
          (command.expectedContentHash && journal.content_hash.toLowerCase() !== command.expectedContentHash.toLowerCase())) {
        throw new JournalWorkflowError("STALE_VERSION");
      }
      return { journalId: journal.id, status: "SUBMITTED" as const, contentHash: journal.content_hash, approvalVersion: journal.approval_version, idempotentReplay: true };
    }
    if (journal.status !== "DRAFT") throw new JournalWorkflowError("INVALID_STATE");
    await assertWorkflowAction(client, context, journal.id, "submit");
    const canonical = await client.query<{ content_hash: string }>(
      "SELECT app.compute_journal_content_hash($1)::text AS content_hash",
      [journal.id],
    );
    const contentHash = canonical.rows[0]?.content_hash;
    if (!contentHash) throw new Error("Journal content hash could not be calculated");
    if (command.expectedContentHash && contentHash.toLowerCase() !== command.expectedContentHash.toLowerCase()) {
      throw new JournalWorkflowError("STALE_VERSION");
    }
    const updated = await client.query<{ content_hash: string; approval_version: number }>(
      `UPDATE journal_entries SET status = 'SUBMITTED'
       WHERE organization_id = $1 AND id = $2 AND status = 'DRAFT'
       RETURNING content_hash, approval_version`,
      [context.organizationId, journal.id],
    );
    const submitted = updated.rows[0];
    if (!submitted) throw new JournalWorkflowError("STALE_VERSION");
    return { journalId: journal.id, status: "SUBMITTED" as const, contentHash: submitted.content_hash, approvalVersion: submitted.approval_version, idempotentReplay: false };
  });
}

export async function approveSubmittedJournal(input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof approveSchema>) {
  const { context, ...unparsedCommand } = input;
  assertTenantWritesEnabled(context);
  const command = approveSchema.parse(unparsedCommand);
  if (context.reason !== command.reason) throw new Error("Approval reason must be bound to the transaction audit context");
  return withTenantTransaction(context, async (client) => {
    await assertWritableOrganization(client, context);
    await assertWorkflowPermission(client, {
      organizationId: context.organizationId,
      actorId: context.actorId,
      permission: PERMISSIONS.approveJournal,
    });
    const current = await client.query<{
      id: string;
      ledger_id: string;
      status: string;
      content_hash: string | null;
      approval_version: number | null;
      created_by: string | null;
      approved_by: string | null;
    }>(
      `SELECT id, ledger_id, status, content_hash, approval_version, created_by, approved_by
       FROM journal_entries
       WHERE organization_id = $1 AND id = $2
       FOR UPDATE`,
      [context.organizationId, command.journalId],
    );
    const journal = current.rows[0];
    if (!journal) throw new JournalWorkflowError("INVALID_STATE");
    if (journal.created_by === context.actorId) throw new JournalWorkflowError("CREATOR_CANNOT_APPROVE");
    if (journal.status === "APPROVED") {
      if (journal.content_hash?.toLowerCase() !== command.expectedContentHash.toLowerCase() ||
          journal.approval_version !== command.expectedApprovalVersion) {
        throw new JournalWorkflowError("STALE_VERSION");
      }
      return { journalId: journal.id, status: "APPROVED" as const, contentHash: journal.content_hash, approvalVersion: journal.approval_version, idempotentReplay: true };
    }
    if (journal.status !== "SUBMITTED" || !journal.content_hash || !journal.approval_version) {
      throw new JournalWorkflowError("INVALID_STATE");
    }
    if (journal.content_hash.toLowerCase() !== command.expectedContentHash.toLowerCase() ||
        journal.approval_version !== command.expectedApprovalVersion) {
      throw new JournalWorkflowError("STALE_VERSION");
    }
    await assertWorkflowAction(client, context, journal.id, "approve");
    await client.query(
      `INSERT INTO journal_approvals (
         id, organization_id, ledger_id, journal_entry_id, journal_version,
         content_hash, decision, actor_id, reason
       ) VALUES ($1,$2,$3,$4,$5,$6,'APPROVED',$7,$8)
       ON CONFLICT (journal_entry_id, journal_version, actor_id) DO NOTHING`,
      [
        randomUUID(),
        input.context.organizationId,
        journal.ledger_id,
        journal.id,
        journal.approval_version,
        journal.content_hash,
        context.actorId,
        command.reason,
      ],
    );
    const updated = await client.query<{ content_hash: string; approval_version: number }>(
      `UPDATE journal_entries
       SET status = 'APPROVED', approved_by = $3, approved_at = now()
       WHERE organization_id = $1 AND id = $2 AND status = 'SUBMITTED'
       RETURNING content_hash, approval_version`,
      [context.organizationId, journal.id, context.actorId],
    );
    if (!updated.rows[0]) throw new JournalWorkflowError("STALE_VERSION");
    return { journalId: journal.id, status: "APPROVED" as const, contentHash: updated.rows[0].content_hash, approvalVersion: updated.rows[0].approval_version, idempotentReplay: false };
  });
}

export const recoverJournalSchema = approveSchema.extend({ idempotencyKey: z.uuidv4() }).strict();

async function recoverSubmittedJournal(action: "withdraw" | "reject", input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof recoverJournalSchema>) {
  const { context, ...unparsedCommand } = input;
  assertTenantWritesEnabled(context);
  const parsed = recoverJournalSchema.parse(unparsedCommand);
  const command = { ...parsed, journalId: parsed.journalId.toLowerCase(), idempotencyKey: parsed.idempotencyKey.toLowerCase() };
  if (context.reason !== command.reason) throw new Error("Recovery reason must be bound to the transaction audit context");
  const commandHash = createHash("sha256").update(JSON.stringify({
    action, actorId: context.actorId, journalId: command.journalId,
    contentHash: command.expectedContentHash.toLowerCase(), approvalVersion: command.expectedApprovalVersion,
    reason: command.reason,
  })).digest("hex");
  return withTenantTransaction(context, async (client) => {
    await assertWritableOrganization(client, context);
    await assertWorkflowPermission(client, {
      organizationId: context.organizationId, actorId: context.actorId,
      permission: action === "reject" ? PERMISSIONS.approveJournal : PERMISSIONS.submitJournal,
    });
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`journal-workflow:${context.organizationId}:${command.idempotencyKey}`],
    );
    const current = await client.query<{ id: string; ledger_id: string; status: string; content_hash: string | null; approval_version: number | null }>(
      `SELECT id, ledger_id, status, content_hash, approval_version FROM journal_entries
       WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [context.organizationId, command.journalId],
    );
    const journal = current.rows[0];
    if (!journal) throw new JournalWorkflowError("INVALID_STATE");
    let replayed: boolean;
    try {
      const replay = await client.query<{ replayed: boolean }>(
        "SELECT app.journal_workflow_recovery_replayed($1,$2,$3,$4) AS replayed",
        [command.journalId, action, command.idempotencyKey, commandHash],
      );
      if (typeof replay.rows[0]?.replayed !== "boolean") throw new Error("Journal recovery replay lookup did not return an authorized result");
      replayed = replay.rows[0].replayed;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        if (error.code === "23505") throw new JournalWorkflowError("STALE_VERSION", "The idempotency key was already used for a different workflow command.");
        if (error.code === "42501") throw new JournalWorkflowError("MISSING_PERMISSION");
      }
      throw error;
    }
    if (replayed) {
      // Return the current state after a replay; never repeat recovery against a newer submission.
      return { journalId: journal.id, status: journal.status, contentHash: journal.content_hash, approvalVersion: journal.approval_version, idempotentReplay: true };
    }
    if (journal.status !== "SUBMITTED") throw new JournalWorkflowError("INVALID_STATE");
    if (journal.content_hash?.toLowerCase() !== command.expectedContentHash.toLowerCase() || journal.approval_version !== command.expectedApprovalVersion) throw new JournalWorkflowError("STALE_VERSION");
    await assertWorkflowAction(client, context, journal.id, action);
    if (action === "reject") {
      await client.query(
        `INSERT INTO journal_approvals (id, organization_id, ledger_id, journal_entry_id, journal_version, content_hash, decision, actor_id, reason)
         VALUES ($1,$2,$3,$4,$5,$6,'REJECTED',$7,$8)`,
        [randomUUID(), context.organizationId, journal.ledger_id, journal.id, command.expectedApprovalVersion, journal.content_hash, context.actorId, command.reason],
      );
    }
    await client.query("SELECT set_config('app.journal_workflow_command', $1, true)", [JSON.stringify({
      action, expectedContentHash: command.expectedContentHash.toLowerCase(), expectedApprovalVersion: command.expectedApprovalVersion,
      idempotencyKey: command.idempotencyKey, commandHash,
    })]);
    const updated = await client.query<{ content_hash: null; approval_version: null }>(
      `UPDATE journal_entries SET status = 'DRAFT'
       WHERE organization_id = $1 AND id = $2 AND status = 'SUBMITTED' RETURNING content_hash, approval_version`,
      [context.organizationId, journal.id],
    );
    if (!updated.rows[0]) throw new JournalWorkflowError("STALE_VERSION");
    return { journalId: journal.id, status: "DRAFT", contentHash: updated.rows[0].content_hash, approvalVersion: updated.rows[0].approval_version, idempotentReplay: false };
  });
}

export function withdrawSubmittedJournal(input: Parameters<typeof recoverSubmittedJournal>[1]) {
  return recoverSubmittedJournal("withdraw", input);
}
export function rejectSubmittedJournal(input: Parameters<typeof recoverSubmittedJournal>[1]) {
  return recoverSubmittedJournal("reject", input);
}
