import "server-only";

import { withTenantTransaction } from "@/db/transaction";
import { exact } from "@/kernel/money";
import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
} from "@/modules/workspace/write-policy";
import {
  recordSettlementSchema,
  resolvedSettlementSchema,
  SETTLEMENT_KIND_POLICY,
} from "./document-model";
import { resolveFx } from "@/modules/fx/rate-resolver";
import { assertPermission, permissionForOwner, withoutContext } from "./ar-ap-access";
import {
  assertRoutineSetup,
  assertSettlementMappings,
  loadAccountingSetup,
  loadAccountCombinations,
} from "./ar-ap-accounting";
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
  assertSettlementCommandAmounts,
  buildSettlementJournalLines,
  buildSettlementSnapshot,
  calculateSettlementAllocations,
} from "./ar-ap-line-building";
import {
  appendSourceDocument,
  insertAndPostJournal,
  insertSettlementAllocations,
  insertSubledgerEvent,
  lockSettlementOpenItems,
  recordFromRow,
  settlementReplayResult,
} from "./ar-ap-persistence";
import type { RecordSettlementCommand, SettlementResult } from "./ar-ap-types";
import { normalizeSettlementFunding, resolveSettlementFunding } from "./settlement-funding";

export async function recordCustomerReceiptOrSupplierPayment(
  unparsedCommand: RecordSettlementCommand,
): Promise<SettlementResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const unresolvedCommand = normalizeSettlementFunding(
    recordSettlementSchema.parse(withoutContext(unparsedCommand)),
  );
  assertSettlementCommandAmounts(unresolvedCommand);
  const policy = SETTLEMENT_KIND_POLICY[unresolvedCommand.kind];
  const idempotencyKey = subledgerOperationKey(
    policy.ownerModule,
    "settlement",
    unresolvedCommand.idempotencyKey,
  );
  const fingerprints = subledgerCommandFingerprints(
    policy.ownerModule,
    "settlement",
    unresolvedCommand,
  );

  return withTenantTransaction(unparsedCommand.context, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    await assertPermission(client, unparsedCommand.context, permissionForOwner(policy.ownerModule, "settle"));
    await assertPermission(client, unparsedCommand.context, PERMISSIONS.postJournal);
    await acquireIdempotencyLock(client, unparsedCommand.context.organizationId, idempotencyKey);
    const replay = await findSourceByIdempotency(
      client,
      unparsedCommand.context.organizationId,
      idempotencyKey,
    );
    if (replay) {
      assertIdempotentSource(replay, fingerprints, "POSTED");
      return settlementReplayResult(client, replay);
    }
    await acquireDocumentIdentityLock(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      unresolvedCommand.sourceNumber,
    );
    if (await currentSourceDocument(
      client,
      unparsedCommand.context.organizationId,
      policy.sourceType,
      unresolvedCommand.sourceNumber,
      true,
    )) {
      throw new Error("Settlement source number already exists in this organization and document type");
    }
    const setup = await loadAccountingSetup(client, {
      organizationId: unparsedCommand.context.organizationId,
      ledgerId: unresolvedCommand.ledgerId,
      legalEntityId: unresolvedCommand.legalEntityId,
      periodId: unresolvedCommand.periodId,
      partyAccountId: unresolvedCommand.partyAccountId,
    });
    const fx = await resolveFx(client, {
      organizationId: unparsedCommand.context.organizationId,
      transactionCurrency: unresolvedCommand.currency,
      functionalCurrency: setup.functional_currency,
      asOfDate: unresolvedCommand.settlementDate,
      explicitFx: unresolvedCommand.fx,
    });
    const command = resolvedSettlementSchema.parse({ ...unresolvedCommand, fx });
    assertRoutineSetup(setup, {
      accountingDate: command.accountingDate,
      currency: command.currency,
      partyRole: policy.partyRole,
    });
    if (command.currency === setup.functional_currency && !exact(command.fx.rate).equals(1)) {
      throw new Error("Functional-currency settlements require an FX rate of exactly 1");
    }
    const funding = resolveSettlementFunding(command);
    const expectedControlKind = policy.partyRole === "CUSTOMER" ? "AR" as const : "AP" as const;
    const fundingField = funding.method === "BANK"
      ? "bankAccountCombinationId"
      : "settlementAccountCombinationId";
    const combinations = await loadAccountCombinations(client, {
      organizationId: unparsedCommand.context.organizationId,
      ledgerId: command.ledgerId,
      legalEntityId: command.legalEntityId,
      accountingDate: command.accountingDate,
      references: [
        {
          field: "controlAccountCombinationId",
          combinationId: command.controlAccountCombinationId,
          expectedAccountId: setup.control_account_id,
          expectedControlKinds: [expectedControlKind],
        },
        {
          field: fundingField,
          combinationId: funding.accountCombinationId,
          expectedControlKinds: ["NONE"],
          expectedAccountClasses: [funding.accountClass],
        },
        {
          field: "realizedFxGainAccountCombinationId",
          combinationId: command.realizedFxGainAccountCombinationId,
          expectedControlKinds: ["NONE"],
          expectedAccountClasses: ["REVENUE"],
        },
        {
          field: "realizedFxLossAccountCombinationId",
          combinationId: command.realizedFxLossAccountCombinationId,
          expectedControlKinds: ["NONE"],
          expectedAccountClasses: ["EXPENSE"],
        },
        ...(command.fxRoundingAccountCombinationId ? [{
          field: "fxRoundingAccountCombinationId",
          combinationId: command.fxRoundingAccountCombinationId,
          expectedControlKinds: ["NONE" as const],
        }] : []),
      ],
    });
    assertSettlementMappings(command, setup, combinations);
    const openItems = await lockSettlementOpenItems(client, {
      organizationId: unparsedCommand.context.organizationId,
      ids: command.allocations.map((allocation) => allocation.openItemId),
    });
    const calculatedAllocations = calculateSettlementAllocations(
      command,
      openItems,
      setup.functional_currency,
    );
    const snapshot = buildSettlementSnapshot(command, setup.functional_currency, calculatedAllocations);
    const source = await appendSourceDocument(client, {
      context: unparsedCommand.context,
      ownerModule: policy.ownerModule,
      sourceType: policy.sourceType,
      sourceNumber: command.sourceNumber,
      legalEntityId: command.legalEntityId,
      version: 1,
      status: "POSTED",
      snapshot,
      idempotencyKey,
      commandHash: fingerprints.current,
    });
    const subledgerEventId = await insertSubledgerEvent(client, {
      context: unparsedCommand.context,
      ledgerId: command.ledgerId,
      partyAccountId: command.partyAccountId,
      sourceDocumentId: source.id,
      eventType: command.kind === "CUSTOMER_RECEIPT" ? "CUSTOMER_RECEIPT_RECORDED" : "SUPPLIER_PAYMENT_RECORDED",
      eventVersion: String(source.version),
    });
    const allocationIds = await insertSettlementAllocations(client, {
      context: unparsedCommand.context,
      sourceDocumentId: source.id,
      snapshot,
      allocations: calculatedAllocations,
      baseIdempotencyKey: idempotencyKey,
      commandHash: fingerprints.current,
    });
    const journalLines = buildSettlementJournalLines(snapshot, calculatedAllocations, subledgerEventId);
    const journal = await insertAndPostJournal(client, {
      context: unparsedCommand.context,
      ledgerId: command.ledgerId,
      legalEntityId: command.legalEntityId,
      periodId: command.periodId,
      journalTypeKey: policy.journalTypeKey,
      ownerModule: policy.ownerModule,
      sourceDocumentId: source.id,
      sourceEventKey: `${policy.sourceType}:${source.id}:settled`,
      idempotencyKey,
      commandHash: fingerprints.current,
      purpose: "ROUTINE",
      accountingDate: command.accountingDate,
      functionalCurrency: setup.functional_currency,
      description: command.description,
      lines: journalLines,
    });
    return {
      document: recordFromRow(source),
      idempotentReplay: false,
      journalId: journal.journalId,
      journalNumber: journal.journalNumber,
      subledgerEventId,
      allocationIds,
    };
  });
}
