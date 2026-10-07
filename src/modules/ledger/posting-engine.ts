import type { PoolClient } from "pg";
import type { TenantTransactionContext } from "@/db/transaction";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";

const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/i;

export type PostJournalCommand = Readonly<{
  context: TenantTransactionContext;
  journalId: string;
  expectedContentHash?: string;
  expectedApprovalVersion?: number;
}>;

export type PostJournalResult = Readonly<{
  journalId: string;
  journalNumber: number;
  status: "POSTED";
  idempotentReplay: boolean;
}>;

export type PostingBoundary = PostJournalCommand & Readonly<{
  requiredOwnerModule?: string;
  requiredJournalType?: string;
}>;

type LockedJournal = {
  id: string;
  organization_id: string;
  ledger_id: string;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "POSTED" | "REVERSED";
  content_hash: string | null;
  approval_version: number | null;
  journal_number: number | null;
  journal_type_key: string;
  owner_module: string;
};

async function lockJournal(
  client: PoolClient,
  organizationId: string,
  journalId: string,
): Promise<LockedJournal> {
  const result = await client.query<LockedJournal>(
    `SELECT entry.id, entry.organization_id, entry.ledger_id, entry.status,
       entry.content_hash, entry.approval_version, entry.journal_number, entry.journal_type_key,
       journal_type.owner_module
     FROM journal_entries entry
     JOIN journal_type_definitions journal_type
       ON journal_type.id = entry.journal_type_definition_id
      AND journal_type.key = entry.journal_type_key
      AND journal_type.version = entry.journal_type_version
     WHERE entry.organization_id = $1 AND entry.id = $2
     FOR UPDATE OF entry`,
    [organizationId, journalId],
  );

  const journal = result.rows[0];
  if (!journal) {
    throw new Error("Journal was not found in the authorized organization");
  }

  return journal;
}

function normalizeExpectedContentHash(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!CONTENT_HASH_PATTERN.test(value)) {
    throw new Error("Expected journal content hash must be a 64-character hexadecimal value");
  }
  return value.toLowerCase();
}

async function computeCanonicalContentHash(client: PoolClient, journalId: string): Promise<string> {
  const result = await client.query<{ content_hash: string | null }>(
    "SELECT app.compute_journal_content_hash($1)::text AS content_hash",
    [journalId],
  );
  const contentHash = result.rows[0]?.content_hash;

  if (!contentHash || !CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new Error("Database did not return a valid canonical journal content hash");
  }

  return contentHash.toLowerCase();
}

/**
 * Apply permission, ownership, workflow, and integrity checks inside a
 * transaction whose caller has already established its write boundary.
 * Interactive callers go through posting-service; isolated owner-only
 * maintenance tools may call this engine inside their controlled transaction.
 */
export async function postJournalInTransaction(
  client: PoolClient,
  command: PostingBoundary,
): Promise<PostJournalResult> {
  const expectedContentHash = normalizeExpectedContentHash(command.expectedContentHash);
  if (command.expectedApprovalVersion !== undefined &&
      (!Number.isSafeInteger(command.expectedApprovalVersion) || command.expectedApprovalVersion < 1)) {
    throw Object.assign(new Error("Expected approval version must be a positive integer"), {
      code: "INVALID_APPROVAL_VERSION",
    });
  }
  await assertActorHasActivePermission(client, {
    organizationId: command.context.organizationId,
    actorId: command.context.actorId,
    permission: PERMISSIONS.postJournal,
  });

  const journal = await lockJournal(client, command.context.organizationId, command.journalId);

  if (command.requiredOwnerModule !== undefined && journal.owner_module !== command.requiredOwnerModule) {
    throw new Error(`This journal must be posted from its owning ${journal.owner_module} module`);
  }
  if (command.requiredJournalType !== undefined && journal.journal_type_key !== command.requiredJournalType) {
    throw new Error("Only a manual general-ledger journal can be posted from the journal register");
  }

  if (!new Set(["DRAFT", "SUBMITTED", "APPROVED", "POSTED"]).has(journal.status)) {
    throw new Error(`Journal cannot post from status ${journal.status}`);
  }

  if (journal.status === "APPROVED" && command.expectedApprovalVersion === undefined) {
    throw Object.assign(new Error("Read the journal and supply its exact approval version before posting."), {
      code: "STALE_VERSION",
    });
  }
  if (command.expectedApprovalVersion !== undefined &&
      command.expectedApprovalVersion !== journal.approval_version) {
    throw Object.assign(new Error("Journal approval version changed after review. Refresh the journal before posting."), {
      code: "STALE_VERSION",
    });
  }

  const contentHash = await computeCanonicalContentHash(client, journal.id);
  if (expectedContentHash !== undefined && expectedContentHash !== contentHash) {
    throw Object.assign(new Error("Journal content changed after the expected hash was calculated"), {
      code: "STALE_CONTENT_HASH",
    });
  }

  if (journal.status === "POSTED") {
    if (
      journal.content_hash?.toLowerCase() !== contentHash ||
      journal.journal_number === null
    ) {
      throw new Error("Posted journal metadata does not match its canonical content");
    }

    return {
      journalId: journal.id,
      journalNumber: journal.journal_number,
      status: "POSTED",
      idempotentReplay: true,
    };
  }

  const posted = await client.query<{ id: string; journal_number: number }>(
    `UPDATE journal_entries
     SET status = 'POSTED',
         content_hash = $1
     WHERE id = $2 AND organization_id = $3 AND status = $4
     RETURNING id, journal_number`,
    [
      contentHash,
      journal.id,
      command.context.organizationId,
      journal.status,
    ],
  );

  if (!posted.rows[0]) {
    throw new Error("Journal posting did not update an authorized row");
  }

  const journalNumber = Number(posted.rows[0].journal_number);
  if (!Number.isSafeInteger(journalNumber) || journalNumber <= 0) {
    throw new Error("Database journal number allocation failed");
  }

  return {
    journalId: journal.id,
    journalNumber,
    status: "POSTED",
    idempotentReplay: false,
  };
}
