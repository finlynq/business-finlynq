import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { actorHasActivePermission, assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";
import {
  authorizeCloudEvidenceDownload,
  downloadCloudEvidence,
  reauthorizeCloudEvidenceDownload,
  resolveCloudEvidenceDownload,
} from "@/modules/document-storage/evidence";
import {
  EVIDENCE_METADATA_COLUMNS,
  decryptEvidenceContent,
  evidenceMetadata,
  type EvidenceRow,
} from "@/modules/subledger/evidence-store";
import {
  postedJournalEvidenceLinkSchema,
  type PostedJournalEvidenceLinkInput,
} from "./journal-evidence-model";

type JournalEvidenceRow = {
  id: string;
  journal_entry_id: string;
  evidence_asset_id: string;
  source_inbox_item_id: string | null;
  evidence_revision: number;
  journal_content_hash: string;
  document_date: Date | string;
  document_reference: string;
  document_currency: string;
  document_total: string;
  reason: string;
  command_hash: string;
  created_by: string;
  created_at: Date | string;
};

type PostedTarget = {
  id: string;
  legal_entity_id: string;
  ledger_id: string;
  status: string;
  content_hash: string;
};

function commandFingerprint(command: PostedJournalEvidenceLinkInput): string {
  const canonical = {
    assetId: command.assetId,
    inboxItemId: command.inboxItemId ?? null,
    metadata: command.metadata,
    reason: command.reason,
    targets: [...command.targets].sort((a, b) => a.journalId.localeCompare(b.journalId)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function commandKey(idempotencyKey: string): string {
  return `journal-evidence:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

function replayResult(rows: readonly JournalEvidenceRow[], command: PostedJournalEvidenceLinkInput, hash: string) {
  if (!rows.length) return null;
  const actual = rows.map((row) => row.journal_entry_id).sort();
  const expected = command.targets.map((target) => target.journalId).sort();
  if (rows.some((row) => row.command_hash !== hash || row.evidence_asset_id !== command.assetId)
    || actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new Error("Journal evidence idempotency key was used for different arguments");
  }
  return { links: rows.map(linkRecord), idempotentReplay: true };
}

async function assertJournalEvidencePermission(client: PoolClient, context: TenantTransactionContext, assetOwner: string, write: boolean) {
  await assertActorHasActivePermission(client, {
    organizationId: context.organizationId,
    actorId: context.actorId,
    permission: PERMISSIONS.readMcpLedger,
  });
  if (write) await assertActorHasActivePermission(client, {
    organizationId: context.organizationId,
    actorId: context.actorId,
    permission: PERMISSIONS.draftJournal,
  });
  const assetPermissions = assetOwner === "payables"
    ? [PERMISSIONS.managePayables, PERMISSIONS.readPayables]
    : assetOwner === "receivables"
      ? [PERMISSIONS.manageReceivables, PERMISSIONS.readReceivables]
      : null;
  if (!assetPermissions) throw new Error("Evidence asset is unavailable");
  if (write) {
    await assertActorHasActivePermission(client, {
      organizationId: context.organizationId,
      actorId: context.actorId,
      permission: assetPermissions[0],
    });
  } else if (!await actorHasActivePermission(client, {
    organizationId: context.organizationId, actorId: context.actorId, permission: assetPermissions[0],
  }) && !await actorHasActivePermission(client, {
    organizationId: context.organizationId, actorId: context.actorId, permission: assetPermissions[1],
  })) {
    throw new Error("Evidence asset is unavailable");
  }
}

async function loadAsset(client: PoolClient, context: TenantTransactionContext, assetId: string) {
  const result = await client.query<EvidenceRow>(
    `SELECT ${EVIDENCE_METADATA_COLUMNS}, content_ciphertext
     FROM document_evidence_assets WHERE organization_id = $1 AND id = $2`,
    [context.organizationId, assetId],
  );
  if (!result.rows[0]) throw new Error("Evidence asset is unavailable");
  return result.rows[0];
}

async function linkPostedJournalEvidenceInTransaction(
  client: PoolClient,
  context: TenantTransactionContext,
  command: PostedJournalEvidenceLinkInput,
  sourceEntityId: string | null,
) {
  assertTenantWritesEnabled(context);
  await assertWritableOrganization(client, context);
  const asset = await loadAsset(client, context, command.assetId);
  await assertJournalEvidencePermission(client, context, asset.owner_module, true);
  if (!asset.scanner_version || !asset.scanned_at || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error("Evidence asset has no valid integrity review");
  }
  if (asset.storage_backend === "CLOUD" && !sourceEntityId) {
    throw new Error("A cloud evidence asset requires its exact filed inbox source");
  }

  const key = commandKey(command.idempotencyKey);
  const hash = commandFingerprint(command);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `journal-evidence:${context.organizationId}:${key}`,
  ]);
  const replay = await client.query<JournalEvidenceRow>(
    `SELECT * FROM journal_evidence_links
     WHERE organization_id = $1 AND idempotency_key = $2 ORDER BY journal_entry_id`,
    [context.organizationId, key],
  );
  const replayed = replayResult(replay.rows, command, hash);
  if (replayed) return replayed;

  // A journal's evidence revision must remain visible to every actor who can
  // manage its evidence. Mixing module-owned assets would let RLS hide earlier
  // links and make a later writer reuse an already assigned revision.
  const existingModules = await client.query<{ owner_module: string }>(
    `SELECT DISTINCT asset.owner_module FROM journal_evidence_links link
     JOIN document_evidence_assets asset ON asset.organization_id = link.organization_id
       AND asset.id = link.evidence_asset_id
     WHERE link.organization_id = $1 AND link.journal_entry_id = ANY($2::uuid[])`,
    [context.organizationId, command.targets.map((target) => target.journalId)],
  );
  if (existingModules.rows.some((row) => row.owner_module !== asset.owner_module)) {
    throw new Error("A posted journal can only link originals from one accounting module");
  }
  const priorTargets = await client.query<{ legal_entity_id: string; ledger_id: string }>(
    `SELECT DISTINCT journal.legal_entity_id, journal.ledger_id
     FROM journal_evidence_links link
     JOIN journal_entries journal ON journal.organization_id = link.organization_id
       AND journal.id = link.journal_entry_id
     WHERE link.organization_id = $1 AND link.evidence_asset_id = $2`,
    [context.organizationId, asset.id],
  );

  let entityId: string | null = null;
  let ledgerId: string | null = null;
  const ordered = [...command.targets].sort((a, b) => a.journalId.localeCompare(b.journalId));
  const links: JournalEvidenceRow[] = [];
  for (const target of ordered) {
    const journalResult = await client.query<PostedTarget>(
      `SELECT id, legal_entity_id, ledger_id, status, content_hash
       FROM journal_entries WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [context.organizationId, target.journalId],
    );
    const journal = journalResult.rows[0];
    if (!journal || journal.status !== "POSTED" || journal.content_hash !== target.expectedContentHash) {
      throw new Error("Choose the exact current posted journal and content hash");
    }
    if (sourceEntityId && journal.legal_entity_id !== sourceEntityId) {
      throw new Error("Evidence and journal must belong to the same legal entity");
    }
    if (priorTargets.rows.some((prior) => prior.legal_entity_id !== journal.legal_entity_id
      || prior.ledger_id !== journal.ledger_id)) {
      throw new Error("An original document cannot be linked across companies or ledgers");
    }
    if (entityId && (journal.legal_entity_id !== entityId || journal.ledger_id !== ledgerId)) {
      throw new Error("All targets for one original document must share a legal entity and ledger");
    }
    entityId = journal.legal_entity_id;
    ledgerId = journal.ledger_id;

    const revisionResult = await client.query<{ revision: number; duplicate_content: boolean }>(
      `SELECT count(*)::integer AS revision,
         EXISTS (SELECT 1 FROM journal_evidence_links link
           JOIN document_evidence_assets prior_asset
             ON prior_asset.organization_id = link.organization_id
            AND prior_asset.id = link.evidence_asset_id
           WHERE link.organization_id = $1 AND link.journal_entry_id = $2
             AND prior_asset.sha256 = $3) AS duplicate_content
       FROM journal_evidence_links WHERE organization_id = $1 AND journal_entry_id = $2`,
      [context.organizationId, journal.id, asset.sha256],
    );
    const revision = revisionResult.rows[0]?.revision ?? 0;
    if (revision !== target.expectedEvidenceRevision) {
      throw new Error("Journal evidence changed; refresh its current revision");
    }
    if (revisionResult.rows[0]?.duplicate_content) {
      throw new Error("The original document is already linked to this journal");
    }
    const inserted = await client.query<JournalEvidenceRow>(
      `INSERT INTO journal_evidence_links (
         id, organization_id, journal_entry_id, evidence_asset_id, source_inbox_item_id,
         evidence_revision, journal_content_hash, document_date,
         document_reference, document_currency, document_total, reason,
         idempotency_key, command_hash, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [randomUUID(), context.organizationId, journal.id, asset.id, command.inboxItemId ?? null,
        revision + 1, target.expectedContentHash, command.metadata.documentDate,
        command.metadata.reference, command.metadata.currency, command.metadata.total,
        command.reason, key, hash, context.actorId],
    );
    links.push(inserted.rows[0]);
  }
  return { links: links.map(linkRecord), idempotentReplay: false };
}

function linkRecord(row: JournalEvidenceRow) {
  return {
    linkId: row.id,
    journalId: row.journal_entry_id,
    assetId: row.evidence_asset_id,
    sourceInboxItemId: row.source_inbox_item_id,
    evidenceRevision: row.evidence_revision,
    journalContentHash: row.journal_content_hash,
    documentDate: row.document_date instanceof Date
      ? row.document_date.toISOString().slice(0, 10)
      : row.document_date,
    documentReference: row.document_reference,
    documentCurrency: row.document_currency,
    documentTotal: row.document_total,
    reason: row.reason,
    linkedBy: row.created_by,
    linkedAt: new Date(row.created_at).toISOString(),
  };
}

export async function linkPostedJournalEvidence(
  context: TenantTransactionContext,
  unparsed: PostedJournalEvidenceLinkInput,
) {
  const command = postedJournalEvidenceLinkSchema.parse(unparsed);
  if (command.inboxItemId) {
    const asset = await withTenantTransaction(context, (client) => loadAsset(client, context, command.assetId));
    if (asset.storage_backend !== "CLOUD") {
      throw new Error("Only cloud evidence can refer to a filed inbox item");
    }
  }
  const existing = await withTenantTransaction(context, async (client) => {
    const asset = await loadAsset(client, context, command.assetId);
    await assertJournalEvidencePermission(client, context, asset.owner_module, true);
    const replay = await client.query<JournalEvidenceRow>(
      `SELECT * FROM journal_evidence_links
       WHERE organization_id = $1 AND idempotency_key = $2 ORDER BY journal_entry_id`,
      [context.organizationId, commandKey(command.idempotencyKey)],
    );
    return replayResult(replay.rows, command, commandFingerprint(command));
  });
  if (existing) return existing;
  // Verify the original bytes before saving an immutable amendment. A cloud
  // transfer runs outside a database transaction and is reauthorized afterward.
  const verified = await withTenantTransaction(context, async (client) => {
    const asset = await loadAsset(client, context, command.assetId);
    await assertJournalEvidencePermission(client, context, asset.owner_module, true);
    if (asset.storage_backend === "CLOUD") {
      return { kind: "cloud" as const, asset, access: await authorizeCloudEvidenceDownload(client, context, asset) };
    }
    const bytes = await decryptEvidenceContent(client, asset);
    bytes.fill(0);
    return { kind: "database" as const };
  });
  if (verified.kind === "cloud") {
    const access = await resolveCloudEvidenceDownload(context, verified.access);
    const bytes = await downloadCloudEvidence(access, verified.asset);
    bytes.fill(0);
    await withTenantTransaction(context, async (client) => {
      const asset = await loadAsset(client, context, command.assetId);
      await assertJournalEvidencePermission(client, context, asset.owner_module, true);
      await reauthorizeCloudEvidenceDownload(client, context, asset);
    });
  }
  return withTenantTransaction({ ...context, reason: command.reason }, async (client) => {
    const asset = await loadAsset(client, context, command.assetId);
    let sourceEntityId: string | null = null;
    if (asset.storage_backend === "CLOUD") {
      if (!command.inboxItemId) throw new Error("Choose the exact filed inbox item for this cloud asset");
      const source = await client.query<{ legal_entity_id: string }>(
        `SELECT connection.legal_entity_id
         FROM document_inbox_items item
         JOIN document_storage_connections connection
           ON connection.organization_id = item.organization_id
          AND connection.id = item.connection_id
         WHERE item.organization_id = $1 AND item.id = $2
           AND item.asset_id = $3 AND item.status = 'FILED'
           AND connection.owner_module = $4`,
        [context.organizationId, command.inboxItemId, command.assetId, asset.owner_module],
      );
      sourceEntityId = source.rows[0]?.legal_entity_id ?? null;
      if (!sourceEntityId) throw new Error("Evidence asset is not filed from that inbox item");
    }
    return linkPostedJournalEvidenceInTransaction(client, context, command, sourceEntityId);
  });
}

export async function linkFiledInboxEvidenceInTransaction(
  client: PoolClient,
  context: TenantTransactionContext,
  command: PostedJournalEvidenceLinkInput,
  sourceEntityId: string,
) {
  return linkPostedJournalEvidenceInTransaction(client, context, postedJournalEvidenceLinkSchema.parse(command), sourceEntityId);
}

export async function listPostedJournalEvidence(context: TenantTransactionContext, journalId: string) {
  return withTenantTransaction(context, async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: context.organizationId,
      actorId: context.actorId,
      permission: PERMISSIONS.readMcpLedger,
    });
    const journal = await client.query<{ id: string; legal_entity_id: string; ledger_id: string; status: string; content_hash: string }>(
      "SELECT id, legal_entity_id, ledger_id, status, content_hash FROM journal_entries WHERE organization_id = $1 AND id = $2",
      [context.organizationId, journalId],
    );
    if (!journal.rows[0]) throw new Error("Journal is unavailable");
    const result = await client.query<JournalEvidenceRow & EvidenceRow>(
      `SELECT link.*, asset.owner_module, asset.filename_ciphertext,
         asset.content_ciphertext, asset.key_version, asset.mime_type,
         asset.byte_size, asset.sha256, asset.uploaded_by,
         asset.created_at AS asset_created_at, asset.scanner_version,
         asset.scanned_at, asset.storage_backend, asset.storage_connection_id,
         asset.provider_file_id
       FROM journal_evidence_links link
       JOIN document_evidence_assets asset
         ON asset.organization_id = link.organization_id
        AND asset.id = link.evidence_asset_id
       WHERE link.organization_id = $1 AND link.journal_entry_id = $2
       ORDER BY link.evidence_revision`,
      [context.organizationId, journalId],
    );
    const links = [];
    for (const row of result.rows) {
      await assertJournalEvidencePermission(client, context, row.owner_module, false);
      links.push({
        ...linkRecord(row),
        asset: await evidenceMetadata(client, {
          ...row,
          id: row.evidence_asset_id,
          created_at: (row as typeof row & { asset_created_at: Date | string }).asset_created_at,
        }),
        storageBackend: row.storage_backend ?? "DATABASE",
        downloadUrl: `/api/ledger/journals/${journalId}/evidence/${row.evidence_asset_id}`,
      });
    }
    return {
      journalId,
      legalEntityId: journal.rows[0].legal_entity_id,
      ledgerId: journal.rows[0].ledger_id,
      journalStatus: journal.rows[0].status,
      journalContentHash: journal.rows[0].content_hash,
      evidenceRevision: links.at(-1)?.evidenceRevision ?? 0,
      links,
    };
  });
}

async function authorizedJournalEvidenceRow(
  client: PoolClient,
  context: TenantTransactionContext,
  journalId: string,
  assetId: string,
) {
  const journal = await client.query<{ status: string }>(
    "SELECT status FROM journal_entries WHERE organization_id=$1 AND id=$2",
    [context.organizationId, journalId],
  );
  if (!journal.rows[0]) throw new Error("Journal evidence is unavailable");
  const link = await client.query<JournalEvidenceRow>(
    `SELECT * FROM journal_evidence_links
     WHERE organization_id=$1 AND journal_entry_id=$2 AND evidence_asset_id=$3`,
    [context.organizationId, journalId, assetId],
  );
  if (!link.rows[0]) throw new Error("Journal evidence is unavailable");
  const asset = await loadAsset(client, context, assetId);
  await assertJournalEvidencePermission(client, context, asset.owner_module, false);
  return { link: link.rows[0], asset };
}

export async function downloadPostedJournalEvidence(
  context: TenantTransactionContext,
  journalId: string,
  assetId: string,
) {
  const prepared = await withTenantTransaction(context, async (client) => {
    const { link, asset } = await authorizedJournalEvidenceRow(client, context, journalId, assetId);
    const metadata = { ...linkRecord(link), asset: await evidenceMetadata(client, asset) };
    if (asset.storage_backend !== "CLOUD") {
      return { kind: "database" as const, metadata, bytes: await decryptEvidenceContent(client, asset) };
    }
    return {
      kind: "cloud" as const,
      metadata,
      asset,
      access: await authorizeCloudEvidenceDownload(client, context, asset),
    };
  });
  if (prepared.kind === "database") return { metadata: prepared.metadata, bytes: prepared.bytes };
  const access = await resolveCloudEvidenceDownload(context, prepared.access);
  const bytes = await downloadCloudEvidence(access, prepared.asset);
  try {
    await withTenantTransaction(context, async (client) => {
      const { asset } = await authorizedJournalEvidenceRow(client, context, journalId, assetId);
      await reauthorizeCloudEvidenceDownload(client, context, asset);
    });
    return { metadata: prepared.metadata, bytes };
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}
