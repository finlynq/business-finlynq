import type { PoolClient } from "pg";
import {
  createCommandFingerprint,
  matchesStoredCommandFingerprint,
  type TransitionalCommandFingerprints,
} from "@/kernel/command-fingerprint";
import {
  canonicalHash,
  type SubledgerOwnerModule,
} from "./document-model";
import type { SourceDocumentRow, SourceDocumentStatus } from "./ar-ap-types";

export function subledgerOperationKey(
  ownerModule: SubledgerOwnerModule,
  operation: string,
  suppliedKey: string,
): string {
  return `subledger:${ownerModule}:${operation}:${canonicalHash(suppliedKey).slice(0, 40)}`;
}

type FingerprintedSubledgerOperation =
  | "draft-create"
  | "draft-edit"
  | "issue"
  | "settlement"
  | "settlement-void"
  | "void";

export function subledgerCommandFingerprints(
  ownerModule: SubledgerOwnerModule,
  operation: FingerprintedSubledgerOperation,
  command: unknown,
): TransitionalCommandFingerprints {
  const payload = { operation, command };
  return {
    current: createCommandFingerprint(`subledger.${ownerModule}.${operation}`, payload),
    legacy: canonicalHash(payload),
  };
}

export async function acquireIdempotencyLock(
  client: PoolClient,
  organizationId: string,
  key: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`${organizationId}:${key}`],
  );
}

export async function acquireDocumentIdentityLock(
  client: PoolClient,
  organizationId: string,
  sourceType: string,
  sourceNumber: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`${organizationId}:${sourceType}:${sourceNumber}`],
  );
}

export async function acquireOpenItemLocks(
  client: PoolClient,
  organizationId: string,
  openItemIds: readonly string[],
): Promise<void> {
  for (const openItemId of [...new Set(openItemIds)].sort()) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${organizationId}:open-item:${openItemId}`],
    );
  }
}

export async function findSourceByIdempotency(
  client: PoolClient,
  organizationId: string,
  idempotencyKey: string,
): Promise<SourceDocumentRow | undefined> {
  const result = await client.query<SourceDocumentRow>(
    `SELECT id, organization_id, legal_entity_id, owner_module, source_type,
       source_number, version, status, snapshot, content_hash, command_hash,
       supersedes_source_document_id, void_reason, created_by, created_at
     FROM source_documents
     WHERE organization_id = $1 AND idempotency_key = $2`,
    [organizationId, idempotencyKey],
  );
  return result.rows[0];
}

export function assertIdempotentSource(
  row: SourceDocumentRow,
  fingerprints: TransitionalCommandFingerprints,
  status?: SourceDocumentStatus,
): void {
  if (
    !matchesStoredCommandFingerprint(row.command_hash, fingerprints)
    || (status !== undefined && row.status !== status)
  ) {
    throw new Error("Idempotency key is already bound to a different subledger command");
  }
}

export async function currentSourceDocument(
  client: PoolClient,
  organizationId: string,
  sourceType: string,
  sourceNumber: string,
  lock: boolean,
): Promise<SourceDocumentRow | undefined> {
  if (lock) {
    await acquireDocumentIdentityLock(client, organizationId, sourceType, sourceNumber);
  }
  const result = await client.query<SourceDocumentRow>(
    `SELECT id, organization_id, legal_entity_id, owner_module, source_type,
       source_number, version, status, snapshot, content_hash, command_hash,
       supersedes_source_document_id, void_reason, created_by, created_at
     FROM source_documents
     WHERE organization_id = $1 AND source_type = $2 AND source_number = $3
     ORDER BY version DESC
     LIMIT 1`,
    [organizationId, sourceType, sourceNumber],
  );
  return result.rows[0];
}
