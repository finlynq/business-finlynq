import type { PoolClient } from "pg";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";

const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/i;

export type PostJournalCommand = Readonly<{
  context: TenantTransactionContext;
  journalId: string;
  expectedContentHash?: string;
}>;

export type PostJournalResult = Readonly<{
  journalId: string;
  journalNumber: number;
  status: "POSTED";
  idempotentReplay: boolean;
}>;

type LockedJournal = {
  id: string;
  organization_id: string;
  ledger_id: string;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "POSTED" | "REVERSED";
  content_hash: string | null;
  journal_number: number | null;
};

async function lockJournal(
  client: PoolClient,
  organizationId: string,
  journalId: string,
): Promise<LockedJournal> {
  const result = await client.query<LockedJournal>(
    `SELECT id, organization_id, ledger_id, status, content_hash, journal_number
     FROM journal_entries
     WHERE organization_id = $1 AND id = $2
     FOR UPDATE`,
    [organizationId, journalId],
  );

  const journal = result.rows[0];
  if (!journal) {
    throw new Error("Journal was not found in the authorized organization");
  }

  return journal;
}

function assertBusinessWritesEnabled(): void {
  if (process.env.BUSINESS_WRITES_ENABLED !== "true") {
    throw new Error("Business writes are disabled");
  }
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

export async function postJournalInTransaction(
  client: PoolClient,
  command: PostJournalCommand,
): Promise<PostJournalResult> {
  const expectedContentHash = normalizeExpectedContentHash(command.expectedContentHash);
  await assertActorHasActivePermission(client, {
    organizationId: command.context.organizationId,
    actorId: command.context.actorId,
    permission: PERMISSIONS.postJournal,
  });

  const journal = await lockJournal(client, command.context.organizationId, command.journalId);

  if (!new Set(["DRAFT", "SUBMITTED", "APPROVED", "POSTED"]).has(journal.status)) {
    throw new Error(`Journal cannot post from status ${journal.status}`);
  }

  const contentHash = await computeCanonicalContentHash(client, journal.id);
  if (expectedContentHash !== undefined && expectedContentHash !== contentHash) {
    throw new Error("Journal content changed after the expected hash was calculated");
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

export async function postJournal(command: PostJournalCommand): Promise<PostJournalResult> {
  assertBusinessWritesEnabled();
  return withTenantTransaction(command.context, async (client) => {
    return postJournalInTransaction(client, command);
  });
}
