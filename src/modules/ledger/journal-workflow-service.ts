import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/i);

const submitSchema = z.object({
  journalId: z.uuid(),
  expectedContentHash: hashSchema.optional(),
}).strict();

const approveSchema = z.object({
  journalId: z.uuid(),
  expectedContentHash: hashSchema,
  expectedApprovalVersion: z.number().int().positive(),
  reason: z.string().trim().min(5).max(500),
}).strict();

export async function submitJournalForApproval(input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof submitSchema>) {
  assertTenantWritesEnabled(input.context);
  const command = submitSchema.parse(input);
  return withTenantTransaction(input.context, async (client) => {
    await assertWritableOrganization(client, input.context);
    await assertActorHasActivePermission(client, {
      organizationId: input.context.organizationId,
      actorId: input.context.actorId,
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
      [input.context.organizationId, command.journalId],
    );
    const journal = current.rows[0];
    if (!journal || journal.owner_module !== "ledger" || journal.journal_type_key !== "ledger.manual") {
      throw new Error("Only a manual general-ledger journal can be submitted here");
    }
    if (journal.status === "SUBMITTED") {
      if (!journal.content_hash || !journal.approval_version ||
          (command.expectedContentHash && journal.content_hash.toLowerCase() !== command.expectedContentHash.toLowerCase())) {
        throw new Error("The submitted journal does not match the expected content");
      }
      return { journalId: journal.id, status: "SUBMITTED" as const, contentHash: journal.content_hash, approvalVersion: journal.approval_version, idempotentReplay: true };
    }
    if (journal.status !== "DRAFT") throw new Error(`Journal cannot be submitted from status ${journal.status}`);
    const canonical = await client.query<{ content_hash: string }>(
      "SELECT app.compute_journal_content_hash($1)::text AS content_hash",
      [journal.id],
    );
    const contentHash = canonical.rows[0]?.content_hash;
    if (!contentHash) throw new Error("Journal content hash could not be calculated");
    if (command.expectedContentHash && contentHash.toLowerCase() !== command.expectedContentHash.toLowerCase()) {
      throw new Error("Journal content changed after it was reviewed");
    }
    const updated = await client.query<{ content_hash: string; approval_version: number }>(
      `UPDATE journal_entries SET status = 'SUBMITTED'
       WHERE organization_id = $1 AND id = $2 AND status = 'DRAFT'
       RETURNING content_hash, approval_version`,
      [input.context.organizationId, journal.id],
    );
    const submitted = updated.rows[0];
    if (!submitted) throw new Error("Concurrent journal submission detected");
    return { journalId: journal.id, status: "SUBMITTED" as const, contentHash: submitted.content_hash, approvalVersion: submitted.approval_version, idempotentReplay: false };
  });
}

export async function approveSubmittedJournal(input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof approveSchema>) {
  assertTenantWritesEnabled(input.context);
  const command = approveSchema.parse(input);
  if (input.context.reason !== command.reason) throw new Error("Approval reason must be bound to the transaction audit context");
  return withTenantTransaction(input.context, async (client) => {
    await assertWritableOrganization(client, input.context);
    await assertActorHasActivePermission(client, {
      organizationId: input.context.organizationId,
      actorId: input.context.actorId,
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
      [input.context.organizationId, command.journalId],
    );
    const journal = current.rows[0];
    if (!journal) throw new Error("Journal was not found in the authorized organization");
    if (journal.status === "APPROVED") {
      if (journal.content_hash?.toLowerCase() !== command.expectedContentHash.toLowerCase() ||
          journal.approval_version !== command.expectedApprovalVersion) {
        throw new Error("The approved journal does not match the expected frozen version");
      }
      return { journalId: journal.id, status: "APPROVED" as const, contentHash: journal.content_hash, approvalVersion: journal.approval_version, idempotentReplay: true };
    }
    if (journal.status !== "SUBMITTED" || !journal.content_hash || !journal.approval_version) {
      throw new Error("Only a submitted frozen journal can be approved");
    }
    if (journal.created_by === input.context.actorId) {
      throw new Error("Maker-checker control prevents a journal creator from approving the same journal");
    }
    if (journal.content_hash.toLowerCase() !== command.expectedContentHash.toLowerCase() ||
        journal.approval_version !== command.expectedApprovalVersion) {
      throw new Error("Journal content or approval version changed after review");
    }
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
        input.context.actorId,
        command.reason,
      ],
    );
    const updated = await client.query<{ content_hash: string; approval_version: number }>(
      `UPDATE journal_entries
       SET status = 'APPROVED', approved_by = $3, approved_at = now()
       WHERE organization_id = $1 AND id = $2 AND status = 'SUBMITTED'
       RETURNING content_hash, approval_version`,
      [input.context.organizationId, journal.id, input.context.actorId],
    );
    if (!updated.rows[0]) throw new Error("Concurrent journal approval detected");
    return { journalId: journal.id, status: "APPROVED" as const, contentHash: updated.rows[0].content_hash, approvalVersion: updated.rows[0].approval_version, idempotentReplay: false };
  });
}
