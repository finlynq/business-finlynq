import "server-only";
import { loadDocumentEvidence } from "./evidence-store";
import type { PoolClient } from "pg";
import { evidenceReferencesSchema, type EvidenceReference } from "./evidence-model";

import { withTenantTransaction } from "@/db/transaction";
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
} from "@/modules/workspace/write-policy";
import {
  buildBusinessDocumentSnapshot,
  canonicalHash,
  createBusinessDocumentSchema,
  DOCUMENT_KIND_POLICY,
  editBusinessDocumentSchema,
} from "./document-model";
import { assertPermission, permissionForOwner, withoutContext } from "./ar-ap-access";
import {
  acquireDocumentIdentityLock,
  acquireIdempotencyLock,
  assertIdempotentSource,
  currentSourceDocument,
  findSourceByIdempotency,
  subledgerCommandFingerprints,
  subledgerOperationKey,
} from "./ar-ap-idempotency";
import { loadAccountingSetup, validateDraftConfiguration } from "./ar-ap-accounting";
import { appendSourceDocument, recordFromRow } from "./ar-ap-persistence";
import {
  SOURCE_TYPES_BY_OWNER,
  type CreateBusinessDocumentCommand,
  type DocumentMutationResult,
  type EditBusinessDocumentCommand,
  type GetCurrentDocumentCommand,
  type ListCurrentDocumentsCommand,
  type SourceDocumentRow,
  type SubledgerDocumentRecord,
} from "./ar-ap-types";

export async function listCurrentSubledgerDocuments(
  command: ListCurrentDocumentsCommand,
): Promise<readonly SubledgerDocumentRecord[]> {
  const limit = Math.min(Math.max(command.limit ?? 100, 1), 500);
  const statuses = command.statuses ?? ["DRAFT", "POSTED", "VOIDED"];
  if (statuses.length === 0 || statuses.some((status) =>
    status !== "DRAFT" && status !== "POSTED" && status !== "VOIDED")) {
    throw new Error("At least one valid source-document status is required");
  }
  return withTenantTransaction(command.context, async (client) => {
    await assertPermission(client, command.context, permissionForOwner(command.ownerModule, "read"));
    const result = await client.query<SourceDocumentRow>(
      `SELECT current.id, current.organization_id, current.legal_entity_id,
         current.owner_module, current.source_type, current.source_number,
         current.version, current.status, current.snapshot, current.content_hash,
         current.command_hash, current.supersedes_source_document_id,
         current.void_reason, current.created_by, current.created_at
       FROM source_documents current
       WHERE current.organization_id = $1 AND current.owner_module = $2
         AND current.source_type = ANY($3::text[])
         AND current.status = ANY($4::text[])
         AND NOT EXISTS (
           SELECT 1 FROM source_documents newer
           WHERE newer.organization_id = current.organization_id
             AND newer.source_type = current.source_type
             AND newer.source_number = current.source_number
             AND newer.version > current.version
         )
       ORDER BY current.created_at DESC, current.source_number
       LIMIT $5`,
      [
        command.context.organizationId,
        command.ownerModule,
        SOURCE_TYPES_BY_OWNER[command.ownerModule],
        statuses,
        limit,
      ],
    );
    return result.rows.map(recordFromRow);
  });
}

export async function getCurrentSubledgerDocument(
  command: GetCurrentDocumentCommand,
): Promise<SubledgerDocumentRecord | null> {
  const sourceNumber = command.sourceNumber.trim().toUpperCase();
  if (!SOURCE_TYPES_BY_OWNER[command.ownerModule].includes(command.sourceType)) {
    throw new Error("Source type does not belong to the requested AR/AP module");
  }
  return withTenantTransaction(command.context, async (client) => {
    await assertPermission(client, command.context, permissionForOwner(command.ownerModule, "read"));
    const row = await currentSourceDocument(
      client,
      command.context.organizationId,
      command.sourceType,
      sourceNumber,
      false,
    );
    if (!row) return null;
    const document = recordFromRow(row);
    return { ...document, attachments: await loadDocumentEvidence(client, {
      organizationId: document.organizationId, ownerModule: document.ownerModule,
      id: document.id, sourceNumber: document.sourceNumber, version: document.version,
      evidence: "evidence" in document.snapshot ? document.snapshot.evidence : undefined,
    }) };
  });
}

export async function createBusinessDocumentDraft(
  unparsedCommand: CreateBusinessDocumentCommand,
): Promise<DocumentMutationResult> {
  return withTenantTransaction(unparsedCommand.context, (client) => createBusinessDocumentDraftInTransaction(client, unparsedCommand));
}

/** Shared with inbox completion so draft creation and evidence linking commit together. */
export async function createBusinessDocumentDraftInTransaction(
  client: PoolClient,
  unparsedCommand: CreateBusinessDocumentCommand,
  evidence: readonly EvidenceReference[] = [],
): Promise<DocumentMutationResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const command = createBusinessDocumentSchema.parse(withoutContext(unparsedCommand));
  const policy = DOCUMENT_KIND_POLICY[command.kind];
  const idempotencyKey = subledgerOperationKey(
    policy.ownerModule,
    "draft-create",
    command.idempotencyKey,
  );
  const refs = evidenceReferencesSchema.parse(evidence);
  const fingerprint = refs.length ? canonicalHash({ command, evidence: refs }) : null;
  const fingerprints = fingerprint ? { current: fingerprint, legacy: fingerprint } : subledgerCommandFingerprints(policy.ownerModule, "draft-create", command);
  await assertWritableOrganization(client, unparsedCommand.context);
  await assertPermission(client, unparsedCommand.context, permissionForOwner(policy.ownerModule, "manage"));
  await acquireIdempotencyLock(client, unparsedCommand.context.organizationId, idempotencyKey);
  const replay = await findSourceByIdempotency(
    client,
    unparsedCommand.context.organizationId,
    idempotencyKey,
  );
  if (replay) {
    assertIdempotentSource(replay, fingerprints, "DRAFT");
    return { document: recordFromRow(replay), idempotentReplay: true };
  }

  await acquireDocumentIdentityLock(
    client,
    unparsedCommand.context.organizationId,
    policy.sourceType,
    command.sourceNumber,
  );
  if (await currentSourceDocument(
    client,
    unparsedCommand.context.organizationId,
    policy.sourceType,
    command.sourceNumber,
    true,
  )) {
    throw new Error("Source number already exists in this organization and document type");
  }

  const setup = await loadAccountingSetup(client, {
    organizationId: unparsedCommand.context.organizationId,
    ledgerId: command.ledgerId,
    legalEntityId: command.legalEntityId,
    periodId: command.periodId,
    partyAccountId: command.partyAccountId,
  });
  const { idempotencyKey: _idempotencyKey, ...documentInput } = command;
  void _idempotencyKey;
  const snapshot = { ...buildBusinessDocumentSnapshot(documentInput, setup.functional_currency), ...(refs.length ? { evidence: refs } : {}) };
  await validateDraftConfiguration(client, unparsedCommand.context, snapshot);
  const row = await appendSourceDocument(client, {
    context: unparsedCommand.context,
    ownerModule: policy.ownerModule,
    sourceType: policy.sourceType,
    sourceNumber: command.sourceNumber,
    legalEntityId: command.legalEntityId,
    version: 1,
    status: "DRAFT",
    snapshot,
    idempotencyKey,
    commandHash: fingerprints.current,
  });
  return { document: recordFromRow(row), idempotentReplay: false };
}

export async function editBusinessDocumentDraft(
  unparsedCommand: EditBusinessDocumentCommand,
): Promise<DocumentMutationResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const command = editBusinessDocumentSchema.parse(withoutContext(unparsedCommand));
  const policy = DOCUMENT_KIND_POLICY[command.kind];
  const idempotencyKey = subledgerOperationKey(
    policy.ownerModule,
    "draft-edit",
    command.idempotencyKey,
  );
  const fingerprints = subledgerCommandFingerprints(policy.ownerModule, "draft-edit", command);

  return withTenantTransaction(unparsedCommand.context, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    await assertPermission(client, unparsedCommand.context, permissionForOwner(policy.ownerModule, "manage"));
    await acquireIdempotencyLock(client, unparsedCommand.context.organizationId, idempotencyKey);
    const replay = await findSourceByIdempotency(
      client,
      unparsedCommand.context.organizationId,
      idempotencyKey,
    );
    if (replay) {
      assertIdempotentSource(replay, fingerprints, "DRAFT");
      return { document: recordFromRow(replay), idempotentReplay: true };
    }

    await acquireDocumentIdentityLock(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      command.sourceNumber,
    );
    const current = await currentSourceDocument(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      command.sourceNumber,
      true,
    );
    if (!current || current.status !== "DRAFT" || current.version !== command.expectedVersion) {
      throw new Error("Draft edit requires the exact current DRAFT version");
    }

    const setup = await loadAccountingSetup(client, {
      organizationId: unparsedCommand.context.organizationId,
      ledgerId: command.ledgerId,
      legalEntityId: command.legalEntityId,
      periodId: command.periodId,
      partyAccountId: command.partyAccountId,
    });
    const {
      idempotencyKey: _idempotencyKey,
      expectedVersion: _expectedVersion,
      ...documentInput
    } = command;
    void _idempotencyKey;
    void _expectedVersion;
    const prior = recordFromRow(current).snapshot;
    const snapshot = {
      ...buildBusinessDocumentSnapshot(documentInput, setup.functional_currency),
      ...("evidence" in prior ? { evidence: prior.evidence } : {}),
    };
    await validateDraftConfiguration(client, unparsedCommand.context, snapshot);
    const row = await appendSourceDocument(client, {
      context: unparsedCommand.context,
      ownerModule: policy.ownerModule,
      sourceType: policy.sourceType,
      sourceNumber: command.sourceNumber,
      legalEntityId: snapshot.legalEntityId,
      version: current.version + 1,
      status: "DRAFT",
      snapshot,
      idempotencyKey,
      commandHash: fingerprints.current,
      supersedesSourceDocumentId: current.id,
    });
    return { document: recordFromRow(row), idempotentReplay: false };
  });
}
