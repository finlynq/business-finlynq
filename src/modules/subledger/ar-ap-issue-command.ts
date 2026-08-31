import "server-only";

import { withTenantTransaction } from "@/db/transaction";
import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
} from "@/modules/workspace/write-policy";
import {
  assertSnapshotTaxDecisionsCurrent,
  businessDocumentSnapshotSchema,
  DOCUMENT_KIND_POLICY,
  issueBusinessDocumentSchema,
} from "./document-model";
import { buildIssueJournalLines } from "./journal-line-builders";
import { assertPermission, permissionForOwner, withoutContext } from "./ar-ap-access";
import { loadTaxPackVersions, validateDraftConfiguration } from "./ar-ap-accounting";
import {
  acquireDocumentIdentityLock,
  acquireIdempotencyLock,
  assertIdempotentSource,
  currentSourceDocument,
  findSourceByIdempotency,
  subledgerCommandFingerprints,
  subledgerOperationKey,
} from "./ar-ap-idempotency";
import {
  appendSourceDocument,
  insertAndPostJournal,
  insertOpenItem,
  insertSubledgerEvent,
  insertTaxDeterminationSnapshots,
  issuedReplayResult,
  recordFromRow,
} from "./ar-ap-persistence";
import type { IssueBusinessDocumentCommand, IssuedDocumentResult } from "./ar-ap-types";

export async function issueBusinessDocument(
  unparsedCommand: IssueBusinessDocumentCommand,
): Promise<IssuedDocumentResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const command = issueBusinessDocumentSchema.parse(withoutContext(unparsedCommand));
  const policy = DOCUMENT_KIND_POLICY[command.kind];
  const idempotencyKey = subledgerOperationKey(
    policy.ownerModule,
    "issue",
    command.idempotencyKey,
  );
  const fingerprints = subledgerCommandFingerprints(policy.ownerModule, "issue", command);

  return withTenantTransaction(unparsedCommand.context, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    await assertPermission(client, unparsedCommand.context, permissionForOwner(policy.ownerModule, "post"));
    await assertPermission(client, unparsedCommand.context, PERMISSIONS.postJournal);
    await acquireIdempotencyLock(client, unparsedCommand.context.organizationId, idempotencyKey);
    const replay = await findSourceByIdempotency(
      client,
      unparsedCommand.context.organizationId,
      idempotencyKey,
    );
    if (replay) {
      assertIdempotentSource(replay, fingerprints, "POSTED");
      return issuedReplayResult(client, replay);
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
      throw new Error("Issue requires the exact current DRAFT version");
    }
    const snapshot = businessDocumentSnapshotSchema.parse(current.snapshot);
    if (snapshot.kind !== command.kind || snapshot.ownerModule !== policy.ownerModule) {
      throw new Error("Draft snapshot does not match its source-document owner module");
    }
    assertSnapshotTaxDecisionsCurrent(snapshot);
    await validateDraftConfiguration(client, unparsedCommand.context, snapshot);
    const packVersions = await loadTaxPackVersions(client, snapshot);

    const postedSource = await appendSourceDocument(client, {
      context: unparsedCommand.context,
      ownerModule: policy.ownerModule,
      sourceType: policy.sourceType,
      sourceNumber: command.sourceNumber,
      legalEntityId: snapshot.legalEntityId,
      version: current.version + 1,
      status: "POSTED",
      snapshot,
      idempotencyKey,
      commandHash: fingerprints.current,
      supersedesSourceDocumentId: current.id,
    });
    const taxSnapshotIds = await insertTaxDeterminationSnapshots(client, {
      context: unparsedCommand.context,
      sourceDocumentId: postedSource.id,
      snapshot,
      packVersions,
    });
    const subledgerEventId = await insertSubledgerEvent(client, {
      context: unparsedCommand.context,
      ledgerId: snapshot.ledgerId,
      partyAccountId: snapshot.partyAccountId,
      sourceDocumentId: postedSource.id,
      eventType: snapshot.kind === "SALES_INVOICE" ? "SALES_INVOICE_ISSUED" : "SUPPLIER_BILL_ISSUED",
      eventVersion: String(postedSource.version),
    });
    const openItemId = await insertOpenItem(client, {
      context: unparsedCommand.context,
      snapshot,
      sourceEventId: subledgerEventId,
    });
    const journalLines = buildIssueJournalLines(snapshot, subledgerEventId, taxSnapshotIds);
    const journal = await insertAndPostJournal(client, {
      context: unparsedCommand.context,
      ledgerId: snapshot.ledgerId,
      legalEntityId: snapshot.legalEntityId,
      periodId: snapshot.periodId,
      journalTypeKey: policy.journalTypeKey,
      ownerModule: policy.ownerModule,
      sourceDocumentId: postedSource.id,
      sourceEventKey: `${policy.sourceType}:${postedSource.id}:issued`,
      idempotencyKey,
      commandHash: fingerprints.current,
      purpose: "ROUTINE",
      accountingDate: snapshot.accountingDate,
      functionalCurrency: snapshot.functionalCurrency,
      description: snapshot.description,
      lines: journalLines,
    });
    return {
      document: recordFromRow(postedSource),
      idempotentReplay: false,
      journalId: journal.journalId,
      journalNumber: journal.journalNumber,
      subledgerEventId,
      openItemId,
    };
  });
}
