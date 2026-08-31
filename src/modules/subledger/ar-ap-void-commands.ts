import "server-only";

import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "@/db/transaction";
import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
} from "@/modules/workspace/write-policy";
import {
  businessDocumentSnapshotSchema,
  DOCUMENT_KIND_POLICY,
  SETTLEMENT_KIND_POLICY,
  settlementDocumentSnapshotSchema,
  voidBusinessDocumentSchema,
  voidSettlementSchema,
} from "./document-model";
import { assertPermission, permissionForOwner, withoutContext } from "./ar-ap-access";
import { loadAccountingSetup } from "./ar-ap-accounting";
import {
  acquireDocumentIdentityLock,
  acquireIdempotencyLock,
  assertIdempotentSource,
  currentSourceDocument,
  findSourceByIdempotency,
  subledgerCommandFingerprints,
  subledgerOperationKey,
} from "./ar-ap-idempotency";
import { reverseJournalLines } from "./ar-ap-line-building";
import {
  appendSourceDocument,
  insertAndPostJournal,
  insertExactAllocationReversals,
  loadOriginalPostedJournal,
  loadOriginalSettlementAllocations,
  lockDocumentOpenItemForVoid,
  recordFromRow,
  voidReplayResult,
  voidSettlementReplayResult,
} from "./ar-ap-persistence";
import type {
  VoidBusinessDocumentCommand,
  VoidedDocumentResult,
  VoidedSettlementResult,
  VoidSettlementCommand,
} from "./ar-ap-types";

export async function voidIssuedBusinessDocument(
  unparsedCommand: VoidBusinessDocumentCommand,
): Promise<VoidedDocumentResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const command = voidBusinessDocumentSchema.parse(withoutContext(unparsedCommand));
  if (unparsedCommand.context.reason !== command.reason) {
    throw new Error("Void reason must be bound to the transaction audit context");
  }
  const policy = DOCUMENT_KIND_POLICY[command.kind];
  const idempotencyKey = subledgerOperationKey(
    policy.ownerModule,
    "void",
    command.idempotencyKey,
  );
  const fingerprints = subledgerCommandFingerprints(policy.ownerModule, "void", command);

  return withTenantTransaction(unparsedCommand.context, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    await assertPermission(client, unparsedCommand.context, permissionForOwner(policy.ownerModule, "void"));
    await assertPermission(client, unparsedCommand.context, PERMISSIONS.postJournal);
    await acquireIdempotencyLock(client, unparsedCommand.context.organizationId, idempotencyKey);
    const replay = await findSourceByIdempotency(
      client,
      unparsedCommand.context.organizationId,
      idempotencyKey,
    );
    if (replay) {
      assertIdempotentSource(replay, fingerprints, "VOIDED");
      return voidReplayResult(client, replay, idempotencyKey);
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
    if (!current || current.status !== "POSTED" || current.version !== command.expectedVersion) {
      throw new Error("Void requires the exact current POSTED document version");
    }
    const snapshot = businessDocumentSnapshotSchema.parse(current.snapshot);
    if (snapshot.kind !== command.kind || snapshot.ownerModule !== policy.ownerModule) {
      throw new Error("Posted snapshot does not match its source-document owner module");
    }
    const setup = await loadAccountingSetup(client, {
      organizationId: unparsedCommand.context.organizationId,
      ledgerId: snapshot.ledgerId,
      legalEntityId: snapshot.legalEntityId,
      periodId: command.periodId,
      partyAccountId: snapshot.partyAccountId,
    });
    if (setup.period_state === "HARD_CLOSED" || setup.period_state === "SEALED") {
      throw new Error("Document reversal requires an open or adjustment-only fiscal period");
    }
    if (command.accountingDate < setup.starts_on || command.accountingDate > setup.ends_on) {
      throw new Error("Void accounting date is outside the selected fiscal period");
    }
    if (setup.period_state === "ADJUSTMENT_ONLY") {
      await assertPermission(client, unparsedCommand.context, PERMISSIONS.postAdjustment);
    }
    const openItemId = await lockDocumentOpenItemForVoid(client, {
      organizationId: unparsedCommand.context.organizationId,
      sourceDocumentId: current.id,
    });
    const original = await loadOriginalPostedJournal(
      client,
      unparsedCommand.context.organizationId,
      current.id,
      policy.journalTypeKey,
    );
    const voidSource = await appendSourceDocument(client, {
      context: unparsedCommand.context,
      ownerModule: policy.ownerModule,
      sourceType: policy.sourceType,
      sourceNumber: command.sourceNumber,
      legalEntityId: snapshot.legalEntityId,
      version: current.version + 1,
      status: "VOIDED",
      snapshot,
      idempotencyKey,
      commandHash: fingerprints.current,
      supersedesSourceDocumentId: current.id,
      voidReason: command.reason,
    });
    const journal = await insertAndPostJournal(client, {
      context: unparsedCommand.context,
      ledgerId: snapshot.ledgerId,
      legalEntityId: snapshot.legalEntityId,
      periodId: command.periodId,
      journalTypeKey: command.kind === "SALES_INVOICE"
        ? "receivables.invoice-void"
        : "payables.bill-void",
      ownerModule: policy.ownerModule,
      // The reversal retains the original immutable accounting source so its
      // copied subledger and tax provenance remains tenant-valid. The VOIDED
      // successor is linked separately by open_item_void_events below.
      sourceDocumentId: current.id,
      sourceEventKey: `${policy.sourceType}:${voidSource.id}:void`,
      idempotencyKey,
      commandHash: fingerprints.current,
      purpose: "REVERSAL",
      accountingDate: command.accountingDate,
      functionalCurrency: snapshot.functionalCurrency,
      description: command.description,
      lines: reverseJournalLines(original.lines),
    });
    await client.query(
      `INSERT INTO journal_entry_relations (
         organization_id, from_journal_id, to_journal_id, kind, reason
       ) VALUES ($1, $2, $3, 'REVERSAL_OF', $4)`,
      [
        unparsedCommand.context.organizationId,
        journal.journalId,
        original.journal.id,
        command.reason,
      ],
    );
    const voidEventId = randomUUID();
    const voidEvent = await client.query<{ id: string }>(
      `INSERT INTO open_item_void_events (
         id, organization_id, ledger_id, open_item_id,
         void_source_document_id, reason, idempotency_key,
         command_hash, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        voidEventId,
        unparsedCommand.context.organizationId,
        snapshot.ledgerId,
        openItemId,
        voidSource.id,
        command.reason,
        idempotencyKey,
        fingerprints.current,
        unparsedCommand.context.actorId,
      ],
    );
    if (!voidEvent.rows[0]) throw new Error("Open-item void event was not persisted");
    return {
      document: recordFromRow(voidSource),
      idempotentReplay: false,
      journalId: journal.journalId,
      journalNumber: journal.journalNumber,
      openItemVoidEventId: voidEventId,
    };
  });
}

export async function voidSettlementAndReverseAllocations(
  unparsedCommand: VoidSettlementCommand,
): Promise<VoidedSettlementResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const command = voidSettlementSchema.parse(withoutContext(unparsedCommand));
  if (unparsedCommand.context.reason !== command.reason) {
    throw new Error("Settlement-void reason must be bound to the transaction audit context");
  }
  const policy = SETTLEMENT_KIND_POLICY[command.kind];
  const idempotencyKey = subledgerOperationKey(
    policy.ownerModule,
    "settlement-void",
    command.idempotencyKey,
  );
  const fingerprints = subledgerCommandFingerprints(policy.ownerModule, "settlement-void", command);

  return withTenantTransaction(unparsedCommand.context, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    await assertPermission(client, unparsedCommand.context, permissionForOwner(policy.ownerModule, "void"));
    await assertPermission(client, unparsedCommand.context, PERMISSIONS.postJournal);
    await acquireIdempotencyLock(client, unparsedCommand.context.organizationId, idempotencyKey);
    const replay = await findSourceByIdempotency(
      client,
      unparsedCommand.context.organizationId,
      idempotencyKey,
    );
    if (replay) {
      assertIdempotentSource(replay, fingerprints, "VOIDED");
      return voidSettlementReplayResult(client, replay, idempotencyKey);
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
    if (!current || current.status !== "POSTED" || current.version !== command.expectedVersion) {
      throw new Error("Settlement void requires the exact current POSTED version");
    }
    const snapshot = settlementDocumentSnapshotSchema.parse(current.snapshot);
    if (snapshot.kind !== command.kind || snapshot.ownerModule !== policy.ownerModule) {
      throw new Error("Settlement snapshot does not match its source-document owner module");
    }
    const setup = await loadAccountingSetup(client, {
      organizationId: unparsedCommand.context.organizationId,
      ledgerId: snapshot.ledgerId,
      legalEntityId: snapshot.legalEntityId,
      periodId: command.periodId,
      partyAccountId: snapshot.partyAccountId,
    });
    if (setup.period_state === "HARD_CLOSED" || setup.period_state === "SEALED") {
      throw new Error("Settlement reversal requires an open or adjustment-only fiscal period");
    }
    if (command.accountingDate < setup.starts_on || command.accountingDate > setup.ends_on) {
      throw new Error("Settlement-void accounting date is outside the selected fiscal period");
    }
    if (setup.period_state === "ADJUSTMENT_ONLY") {
      await assertPermission(client, unparsedCommand.context, PERMISSIONS.postAdjustment);
    }
    const originalAllocations = await loadOriginalSettlementAllocations(
      client,
      unparsedCommand.context.organizationId,
      current.id,
    );
    const originalJournal = await loadOriginalPostedJournal(
      client,
      unparsedCommand.context.organizationId,
      current.id,
      policy.journalTypeKey,
    );
    const voidSource = await appendSourceDocument(client, {
      context: unparsedCommand.context,
      ownerModule: policy.ownerModule,
      sourceType: policy.sourceType,
      sourceNumber: command.sourceNumber,
      legalEntityId: snapshot.legalEntityId,
      version: current.version + 1,
      status: "VOIDED",
      snapshot,
      idempotencyKey,
      commandHash: fingerprints.current,
      supersedesSourceDocumentId: current.id,
      voidReason: command.reason,
    });
    const reversedAllocationIds = await insertExactAllocationReversals(client, {
      context: unparsedCommand.context,
      ledgerId: snapshot.ledgerId,
      voidSourceDocumentId: voidSource.id,
      originals: originalAllocations,
      baseIdempotencyKey: idempotencyKey,
      commandHash: fingerprints.current,
    });
    const journal = await insertAndPostJournal(client, {
      context: unparsedCommand.context,
      ledgerId: snapshot.ledgerId,
      legalEntityId: snapshot.legalEntityId,
      periodId: command.periodId,
      // There is no separate receipt/payment-void registry entry yet. Keeping
      // the original source-owned type plus REVERSAL purpose preserves correct
      // module routing and prevents GL editing.
      journalTypeKey: policy.journalTypeKey,
      ownerModule: policy.ownerModule,
      sourceDocumentId: current.id,
      sourceEventKey: `${policy.sourceType}:${voidSource.id}:void`,
      idempotencyKey,
      commandHash: fingerprints.current,
      purpose: "REVERSAL",
      accountingDate: command.accountingDate,
      functionalCurrency: snapshot.functionalCurrency,
      description: command.description,
      lines: reverseJournalLines(originalJournal.lines),
    });
    await client.query(
      `INSERT INTO journal_entry_relations (
         organization_id, from_journal_id, to_journal_id, kind, reason
       ) VALUES ($1, $2, $3, 'REVERSAL_OF', $4)`,
      [
        unparsedCommand.context.organizationId,
        journal.journalId,
        originalJournal.journal.id,
        command.reason,
      ],
    );
    return {
      document: recordFromRow(voidSource),
      idempotentReplay: false,
      journalId: journal.journalId,
      journalNumber: journal.journalNumber,
      reversedAllocationIds,
    };
  });
}
