import "server-only";

import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction } from "@/db/transaction";
import { createCommandFingerprint } from "@/kernel/command-fingerprint";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import type { SessionPrincipal } from "@/modules/identity/session";
import { assertTenantWritesEnabled, assertWritableOrganization, mutationContext, principalCanWrite } from "@/modules/workspace/write-policy";
import { BankingServiceError } from "./banking-error";

export const bankCutoverPreviewSchema = z.object({
  reconciliationId: z.uuid(),
  predecessorAccountCombinationId: z.uuid(),
  effectiveOn: z.iso.date(),
  migrationJournalLineIds: z.array(z.uuid()).max(20).default([]),
  reason: z.string().trim().min(8).max(500),
}).strict().superRefine((value, context) => {
  if (new Set(value.migrationJournalLineIds).size !== value.migrationJournalLineIds.length) {
    context.addIssue({ code: "custom", path: ["migrationJournalLineIds"], message: "Migration journal line IDs must be unique" });
  }
});

export const bankCutoverCommitSchema = bankCutoverPreviewSchema.safeExtend({
  expectedVersion: z.literal(0),
  confirmationHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export const bankCutoverRevisionSchema = bankCutoverPreviewSchema.safeExtend({
  cutoverId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  lifecycleEffectiveFrom: z.iso.date(),
  confirmationHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export const bankCutoverDeactivationSchema = z.object({
  cutoverId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  effectiveFrom: z.iso.date(),
  reason: z.string().trim().min(8).max(500),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export const bankCutoverListSchema = z.object({
  reconciliationId: z.uuid().optional(),
  lineageId: z.uuid().optional(),
}).strict();

function writeContext(principal: SessionPrincipal, requestId: string, reason: string) {
  return mutationContext(principal, requestId, { reason, sourceSurface: "MCP" });
}

async function withCutoverWrite<T>(input: Readonly<{
  principal: SessionPrincipal; requestId: string; reason: string;
}>, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!principalCanWrite(input.principal)) throw new BankingServiceError("A writable organization session is required.", 403, "WRITES_DISABLED");
  const context = writeContext(input.principal, input.requestId, input.reason);
  assertTenantWritesEnabled(context);
  return withTenantTransaction(context, async (client) => {
    await assertWritableOrganization(client, context);
    await assertActorHasActivePermission(client, { organizationId: input.principal.organizationId, actorId: input.principal.userId, permission: PERMISSIONS.prepareBankReconciliation });
    return work(client);
  });
}

async function withCutoverRead<T>(input: Readonly<{
  principal: SessionPrincipal; requestId: string;
}>, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenantTransaction(writeContext(input.principal, input.requestId, "Read bank account cutover history"), async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: input.principal.organizationId,
      actorId: input.principal.userId,
      permission: PERMISSIONS.readBanking,
    });
    return work(client);
  });
}

function previewCommand(command: z.infer<typeof bankCutoverPreviewSchema>) {
  return {
    reconciliationId: command.reconciliationId,
    predecessorAccountCombinationId: command.predecessorAccountCombinationId,
    effectiveOn: command.effectiveOn,
    migrationJournalLineIds: command.migrationJournalLineIds,
    reason: command.reason,
  };
}

async function preview(client: PoolClient, organizationId: string, raw: z.input<typeof bankCutoverPreviewSchema>) {
  const command = bankCutoverPreviewSchema.parse(raw);
  const session = (await client.query<{
    id: string; status: string; legal_entity_id: string; ledger_id: string;
    successor_id: string; currency_code: string; statement_start_on: string; statement_end_on: string;
  }>(
    `SELECT reconciliation.id, reconciliation.status, reconciliation.legal_entity_id,
       reconciliation.ledger_id, reconciliation.cash_account_combination_id AS successor_id,
       reconciliation.currency_code, reconciliation.statement_start_on::text,
       reconciliation.statement_end_on::text
     FROM bank_reconciliation_sessions reconciliation
     WHERE reconciliation.organization_id=$1 AND reconciliation.id=$2`,
    [organizationId, command.reconciliationId],
  )).rows[0];
  if (!session) throw new BankingServiceError("The reconciliation was not found.", 404, "RECONCILIATION_NOT_FOUND");
  if (session.status !== "DRAFT") throw new BankingServiceError("Cutover proof can be committed only for a draft reconciliation.", 409, "RECONCILIATION_LOCKED");
  if (command.effectiveOn < session.statement_start_on || command.effectiveOn > session.statement_end_on) {
    throw new BankingServiceError("The cutover effective date must fall inside the reconciliation statement range.", 400, "CUTOVER_DATE_INVALID");
  }
  const predecessor = (await client.query<{ id: string; account_class: string; code: string }>(
    `SELECT combination.id, account.class::text AS account_class, account.code
     FROM account_combinations combination
     JOIN gl_accounts account ON account.organization_id=combination.organization_id
       AND account.ledger_id=combination.ledger_id AND account.id=combination.account_id
     WHERE combination.organization_id=$1 AND combination.id=$2
       AND combination.entity_id=$3 AND combination.ledger_id=$4
       AND combination.active AND account.active AND account.postable AND account.control_kind='NONE'`,
    [organizationId, command.predecessorAccountCombinationId, session.legal_entity_id, session.ledger_id],
  )).rows[0];
  const successor = (await client.query<{ account_class: string; code: string }>(
    `SELECT account.class::text AS account_class, account.code
     FROM account_combinations combination JOIN gl_accounts account
       ON account.organization_id=combination.organization_id AND account.ledger_id=combination.ledger_id AND account.id=combination.account_id
     WHERE combination.organization_id=$1 AND combination.id=$2
       AND combination.entity_id=$3 AND combination.ledger_id=$4
       AND combination.active AND account.active AND account.postable AND account.control_kind='NONE'`,
    [organizationId, session.successor_id, session.legal_entity_id, session.ledger_id],
  )).rows[0];
  if (!predecessor || !successor || predecessor.account_class !== successor.account_class || predecessor.id === session.successor_id) {
    throw new BankingServiceError("Choose a distinct active predecessor account of the same class in the reconciliation ledger.", 400, "CUTOVER_ACCOUNT_INVALID");
  }
  const [observations, predecessorLines, migrationLines, allocations] = await Promise.all([
    client.query(
      `WITH latest AS (SELECT DISTINCT ON (observation.id) version.id, version.amount,
         version.posted_on, version.currency_code, version.status
       FROM bank_observations observation JOIN bank_observation_versions version
         ON version.organization_id=observation.organization_id AND version.observation_id=observation.id
       WHERE observation.organization_id=$1 AND observation.external_account_id=(SELECT external_account_id FROM bank_reconciliation_sessions WHERE organization_id=$1 AND id=$2)
       ORDER BY observation.id, version.version_number DESC)
       SELECT id, posted_on::text AS "postedOn", amount::text FROM latest
       WHERE posted_on BETWEEN $3::date AND $4::date
         AND currency_code=$5 AND status='POSTED' ORDER BY posted_on, id`,
      [organizationId, session.id, session.statement_start_on, command.effectiveOn, session.currency_code],
    ),
    client.query(
      `SELECT line.id, journal.id AS "journalId", journal.accounting_date::text AS "accountingDate",
         (line.debit_transaction-line.credit_transaction)::text AS amount
       FROM journal_lines line JOIN journal_entries journal ON journal.organization_id=line.organization_id AND journal.id=line.journal_entry_id AND journal.status='POSTED'
       WHERE line.organization_id=$1 AND line.account_combination_id=$2 AND line.transaction_currency=$3
         AND journal.accounting_date BETWEEN $4::date AND $5::date
         AND NOT (line.id = ANY($6::uuid[]))
       ORDER BY journal.accounting_date, journal.id, line.line_number`,
      [organizationId, predecessor.id, session.currency_code, session.statement_start_on, command.effectiveOn, command.migrationJournalLineIds],
    ),
    command.migrationJournalLineIds.length === 0 ? Promise.resolve({ rows: [] }) : client.query(
      `SELECT line.id, journal.id AS "journalId", journal.accounting_date::text AS "accountingDate",
         line.account_combination_id AS "accountCombinationId",
         (line.debit_transaction-line.credit_transaction)::text AS amount
       FROM journal_lines line JOIN journal_entries journal ON journal.organization_id=line.organization_id AND journal.id=line.journal_entry_id AND journal.status='POSTED'
       WHERE line.organization_id=$1 AND line.id=ANY($2::uuid[])
         AND line.account_combination_id IN ($3,$4)
         AND line.transaction_currency=$5
         AND journal.accounting_date=$6::date
       ORDER BY journal.accounting_date, journal.id, line.line_number`,
      [organizationId, command.migrationJournalLineIds, predecessor.id, session.successor_id,
        session.currency_code, command.effectiveOn],
    ),
    client.query<{
      id: string; observationVersionId: string; journalLineId: string; allocatedAmount: string;
    }>(
      `SELECT allocation.id, allocation.observation_version_id AS "observationVersionId",
         allocation.journal_line_id AS "journalLineId",
         allocation.allocated_amount::text AS "allocatedAmount"
       FROM bank_match_allocations allocation
       LEFT JOIN bank_match_allocation_voids void
         ON void.organization_id=allocation.organization_id AND void.allocation_id=allocation.id
       WHERE allocation.organization_id=$1 AND allocation.reconciliation_session_id=$2
         AND void.id IS NULL
       ORDER BY allocation.id`,
      [organizationId, session.id],
    ),
  ]);
  if (migrationLines.rows.length !== new Set(command.migrationJournalLineIds).size) throw new BankingServiceError("Every migration line must be a posted line on the exact predecessor or successor account.", 400, "CUTOVER_MIGRATION_LINE_INVALID");
  const observationAmounts = observations.rows.map((row) => new Decimal(String((row as { amount: unknown }).amount)));
  const predecessorAmounts = predecessorLines.rows.map((row) => new Decimal(String((row as { amount: unknown }).amount)));
  const migration = migrationLines.rows as Array<{ accountCombinationId: string; amount: string }>;
  const grossIncreases = observationAmounts.filter((amount) => amount.isPositive()).reduce((sum, amount) => sum.plus(amount), new Decimal(0));
  const grossDecreases = observationAmounts.filter((amount) => amount.isNegative()).reduce((sum, amount) => sum.plus(amount.abs()), new Decimal(0));
  const observationNet = observationAmounts.reduce((sum, amount) => sum.plus(amount), new Decimal(0));
  const predecessorNet = predecessorAmounts.reduce((sum, amount) => sum.plus(amount), new Decimal(0));
  const predecessorMigrationNet = migration.filter((line) => line.accountCombinationId === predecessor.id).reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
  const successorMigrationNet = migration.filter((line) => line.accountCombinationId === session.successor_id).reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
  const migrationNet = predecessorMigrationNet.plus(successorMigrationNet);
  const remainingDifference = observationNet.minus(predecessorNet);
  const observationAllocated = new Map<string, Decimal>();
  const ledgerAllocated = new Map<string, Decimal>();
  for (const allocation of allocations.rows) {
    observationAllocated.set(
      allocation.observationVersionId,
      (observationAllocated.get(allocation.observationVersionId) ?? new Decimal(0)).plus(allocation.allocatedAmount),
    );
    ledgerAllocated.set(
      allocation.journalLineId,
      (ledgerAllocated.get(allocation.journalLineId) ?? new Decimal(0)).plus(allocation.allocatedAmount),
    );
  }
  const matchedAmount = allocations.rows.reduce((sum, allocation) => sum.plus(allocation.allocatedAmount), new Decimal(0));
  const unmatchedObservationCount = observations.rows.filter((row) => {
    const selected = row as { id: string; amount: string };
    return !new Decimal(selected.amount).abs().equals(observationAllocated.get(selected.id) ?? 0);
  }).length;
  const unmatchedPredecessorLedgerLineCount = predecessorLines.rows.filter((row) => {
    const selected = row as { id: string; amount: string };
    return !new Decimal(selected.amount).abs().equals(ledgerAllocated.get(selected.id) ?? 0);
  }).length;
  const exceptions: string[] = [];
  if (observations.rows.length === 0) exceptions.push("No current posted observations exist in the declared pre-cutover range.");
  if (predecessorLines.rows.length === 0) exceptions.push("No posted predecessor-account lines exist in the declared pre-cutover range.");
  if (!remainingDifference.isZero()) exceptions.push("The gross observation net does not equal the authorized predecessor ledger population.");
  if (migration.length === 0 || predecessorMigrationNet.isZero() || successorMigrationNet.isZero()) exceptions.push("Select posted migration lines on both the predecessor and successor accounts.");
  if (!migrationNet.isZero()) exceptions.push("The selected migration lines are not balanced between predecessor and successor accounts.");
  if (!predecessorMigrationNet.equals(observationNet.negated()) || !successorMigrationNet.equals(observationNet)) exceptions.push("The selected migration lines do not move the exact proven net amount from predecessor to successor.");
  const proof = {
    reconciliationId: session.id,
    statementRange: { startOn: session.statement_start_on, endOn: session.statement_end_on },
    effectiveOn: command.effectiveOn,
    currencyCode: session.currency_code,
    predecessor: { accountCombinationId: predecessor.id, accountCode: predecessor.code },
    successor: { accountCombinationId: session.successor_id, accountCode: successor.code },
    observations: observations.rows,
    predecessorLedgerLines: predecessorLines.rows,
    migrationLines: migrationLines.rows,
    existingAllocations: allocations.rows,
    grossObservationCount: observations.rows.length,
    grossIncreases: grossIncreases.toFixed(2),
    grossDecreases: grossDecreases.toFixed(2),
    observationNet: observationNet.toFixed(2),
    predecessorLedgerNet: predecessorNet.toFixed(2),
    predecessorMigrationNet: predecessorMigrationNet.toFixed(2),
    successorMigrationNet: successorMigrationNet.toFixed(2),
    migrationNet: migrationNet.toFixed(2),
    remainingDifference: remainingDifference.toFixed(2),
    predecessorLedgerLineCount: predecessorLines.rows.length,
    activeAllocationCount: allocations.rows.length,
    matchedObservationCount: observationAllocated.size,
    matchedLedgerLineCount: ledgerAllocated.size,
    matchedAmount: matchedAmount.toFixed(2),
    unmatchedObservationCount,
    unmatchedPredecessorLedgerLineCount,
    exceptions,
  };
  return { proof, confirmationHash: createHash("sha256").update(JSON.stringify(proof), "utf8").digest("hex"), writesPerformed: false };
}

export async function previewBankAccountCutover(input: Readonly<{
  principal: SessionPrincipal; requestId: string;
}> & z.input<typeof bankCutoverPreviewSchema>) {
  const { principal, requestId, ...command } = input;
  return withCutoverWrite({ principal, requestId, reason: command.reason }, (client) => preview(client, principal.organizationId, command));
}

export async function commitBankAccountCutover(input: Readonly<{
  principal: SessionPrincipal; requestId: string;
}> & z.input<typeof bankCutoverCommitSchema>) {
  const { principal, requestId, ...raw } = input;
  const command = bankCutoverCommitSchema.parse(raw);
  const commandHash = createCommandFingerprint("banking.reconciliation.cutover", { ...command, idempotencyKey: undefined });
  return withCutoverWrite({ principal, requestId, reason: command.reason }, async (client) => {
    const replay = (await client.query<{ id: string; command_hash: string; confirmation_hash: string; version: number; state: string }>(
      `SELECT id, command_hash, confirmation_hash, version, state FROM bank_account_cutovers WHERE organization_id=$1 AND idempotency_key=$2`,
      [principal.organizationId, command.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new BankingServiceError("The cutover idempotency key was used for another declaration.", 409, "IDEMPOTENCY_CONFLICT");
      return { cutoverId: replay.id, confirmationHash: replay.confirmation_hash, version: replay.version, state: replay.state, idempotentReplay: true };
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:bank-cutover:' || $1::text, 0))", [command.reconciliationId]);
    const existing = await client.query(
      `SELECT id FROM bank_account_cutovers cutover
       WHERE organization_id=$1 AND reconciliation_session_id=$2
         AND NOT EXISTS (SELECT 1 FROM bank_account_cutovers successor
           WHERE successor.organization_id=cutover.organization_id
             AND successor.supersedes_cutover_id=cutover.id)
       LIMIT 1`,
      [principal.organizationId, command.reconciliationId],
    );
    if (existing.rows[0] || command.expectedVersion !== 0) {
      throw new BankingServiceError("The cutover mapping already has a current version. Reload its history and revise the exact version.", 409, "CUTOVER_VERSION_CONFLICT");
    }
    const current = await preview(client, principal.organizationId, previewCommand(command));
    if (current.confirmationHash !== command.confirmationHash) throw new BankingServiceError("The cutover proof changed. Preview and review the exact population again.", 409, "CUTOVER_CONFIRMATION_CONFLICT");
    if (current.proof.exceptions.length > 0) throw new BankingServiceError("Resolve every cutover proof exception before commit.", 409, "CUTOVER_PROOF_INCOMPLETE");
    const cutoverId = randomUUID();
    await client.query(
      `INSERT INTO bank_account_cutovers(
         id, organization_id, lineage_id, version, state,
         reconciliation_session_id, predecessor_account_combination_id,
         successor_account_combination_id, effective_on, lifecycle_effective_on,
         supersedes_cutover_id, migration_journal_line_ids,
         proof_snapshot, confirmation_hash, reason, idempotency_key, command_hash, created_by
       ) VALUES ($1,$2,$1,1,'ACTIVE',$3,$4,$5,$6,$6,NULL,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)`,
      [cutoverId, principal.organizationId, command.reconciliationId,
        command.predecessorAccountCombinationId, current.proof.successor.accountCombinationId,
        command.effectiveOn, JSON.stringify(command.migrationJournalLineIds),
        JSON.stringify(current.proof), command.confirmationHash, command.reason,
        command.idempotencyKey, commandHash, principal.userId],
    );
    return { cutoverId, lineageId: cutoverId, version: 1, state: "ACTIVE", confirmationHash: command.confirmationHash, proof: current.proof, idempotentReplay: false };
  });
}

type CurrentCutover = Readonly<{
  id: string; lineage_id: string; version: number; state: "ACTIVE" | "INACTIVE";
  reconciliation_session_id: string; predecessor_account_combination_id: string;
  successor_account_combination_id: string; effective_on: string;
  lifecycle_effective_on: string; migration_journal_line_ids: string[];
  proof_snapshot: unknown; confirmation_hash: string;
}>;

async function currentCutover(client: PoolClient, organizationId: string, cutoverId: string): Promise<CurrentCutover> {
  const row = (await client.query<CurrentCutover>(
    `SELECT cutover.* FROM bank_account_cutovers cutover
     WHERE cutover.organization_id=$1 AND cutover.id=$2
       AND NOT EXISTS (SELECT 1 FROM bank_account_cutovers successor
         WHERE successor.organization_id=cutover.organization_id
           AND successor.supersedes_cutover_id=cutover.id)`,
    [organizationId, cutoverId],
  )).rows[0];
  if (!row) throw new BankingServiceError("The exact current cutover version was not found.", 409, "CUTOVER_VERSION_CONFLICT");
  return row;
}

export async function reviseBankAccountCutover(input: Readonly<{
  principal: SessionPrincipal; requestId: string;
}> & z.input<typeof bankCutoverRevisionSchema>) {
  const { principal, requestId, ...raw } = input;
  const command = bankCutoverRevisionSchema.parse(raw);
  const commandHash = createCommandFingerprint("banking.reconciliation.cutover.revise", { ...command, idempotencyKey: undefined });
  return withCutoverWrite({ principal, requestId, reason: command.reason }, async (client) => {
    const replay = (await client.query<{ id: string; command_hash: string; lineage_id: string; version: number; confirmation_hash: string }>(
      `SELECT id, command_hash, lineage_id, version, confirmation_hash
       FROM bank_account_cutovers WHERE organization_id=$1 AND idempotency_key=$2`,
      [principal.organizationId, command.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new BankingServiceError("The cutover idempotency key was used for another revision.", 409, "IDEMPOTENCY_CONFLICT");
      return { cutoverId: replay.id, lineageId: replay.lineage_id, version: replay.version, state: "ACTIVE", confirmationHash: replay.confirmation_hash, idempotentReplay: true };
    }
    const selected = await currentCutover(client, principal.organizationId, command.cutoverId);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:bank-cutover-lineage:' || $1::text, 0))", [selected.lineage_id]);
    const current = await currentCutover(client, principal.organizationId, command.cutoverId);
    if (current.version !== command.expectedVersion || current.state !== "ACTIVE" ||
        current.reconciliation_session_id !== command.reconciliationId) {
      throw new BankingServiceError("The cutover version is stale or inactive. Reload its immutable history.", 409, "CUTOVER_VERSION_CONFLICT");
    }
    if (command.lifecycleEffectiveFrom <= current.lifecycle_effective_on) {
      throw new BankingServiceError("A cutover revision must become effective after the current lifecycle version.", 400, "CUTOVER_EFFECTIVE_DATE_INVALID");
    }
    const nextProof = await preview(client, principal.organizationId, previewCommand(command));
    if (nextProof.confirmationHash !== command.confirmationHash) throw new BankingServiceError("The cutover proof changed. Preview and review the exact population again.", 409, "CUTOVER_CONFIRMATION_CONFLICT");
    if (nextProof.proof.exceptions.length > 0) throw new BankingServiceError("Resolve every cutover proof exception before revision.", 409, "CUTOVER_PROOF_INCOMPLETE");
    const cutoverId = randomUUID();
    await client.query(
      `INSERT INTO bank_account_cutovers(
         id, organization_id, lineage_id, version, state,
         reconciliation_session_id, predecessor_account_combination_id,
         successor_account_combination_id, effective_on, lifecycle_effective_on,
         supersedes_cutover_id, migration_journal_line_ids, proof_snapshot,
         confirmation_hash, reason, idempotency_key, command_hash, created_by
       ) VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17)`,
      [cutoverId, principal.organizationId, current.lineage_id, current.version + 1,
        command.reconciliationId, command.predecessorAccountCombinationId,
        nextProof.proof.successor.accountCombinationId, command.effectiveOn,
        command.lifecycleEffectiveFrom, current.id,
        JSON.stringify(command.migrationJournalLineIds), JSON.stringify(nextProof.proof),
        command.confirmationHash, command.reason, command.idempotencyKey, commandHash, principal.userId],
    );
    return { cutoverId, lineageId: current.lineage_id, version: current.version + 1, state: "ACTIVE", confirmationHash: command.confirmationHash, proof: nextProof.proof, idempotentReplay: false };
  });
}

export async function deactivateBankAccountCutover(input: Readonly<{
  principal: SessionPrincipal; requestId: string;
}> & z.input<typeof bankCutoverDeactivationSchema>) {
  const { principal, requestId, ...raw } = input;
  const command = bankCutoverDeactivationSchema.parse(raw);
  const commandHash = createCommandFingerprint("banking.reconciliation.cutover.deactivate", { ...command, idempotencyKey: undefined });
  return withCutoverWrite({ principal, requestId, reason: command.reason }, async (client) => {
    const replay = (await client.query<{ id: string; command_hash: string; lineage_id: string; version: number }>(
      `SELECT id, command_hash, lineage_id, version FROM bank_account_cutovers
       WHERE organization_id=$1 AND idempotency_key=$2`,
      [principal.organizationId, command.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new BankingServiceError("The cutover idempotency key was used for another deactivation.", 409, "IDEMPOTENCY_CONFLICT");
      return { cutoverId: replay.id, lineageId: replay.lineage_id, version: replay.version, state: "INACTIVE", idempotentReplay: true };
    }
    const selected = await currentCutover(client, principal.organizationId, command.cutoverId);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:bank-cutover-lineage:' || $1::text, 0))", [selected.lineage_id]);
    const current = await currentCutover(client, principal.organizationId, command.cutoverId);
    if (current.version !== command.expectedVersion || current.state !== "ACTIVE") throw new BankingServiceError("The cutover version is stale or inactive.", 409, "CUTOVER_VERSION_CONFLICT");
    if (command.effectiveFrom <= current.lifecycle_effective_on) throw new BankingServiceError("Deactivation must be prospective to the current lifecycle version.", 400, "CUTOVER_EFFECTIVE_DATE_INVALID");
    const cutoverId = randomUUID();
    await client.query(
      `INSERT INTO bank_account_cutovers(
         id, organization_id, lineage_id, version, state,
         reconciliation_session_id, predecessor_account_combination_id,
         successor_account_combination_id, effective_on, lifecycle_effective_on,
         supersedes_cutover_id, migration_journal_line_ids, proof_snapshot,
         confirmation_hash, reason, idempotency_key, command_hash, created_by
       ) VALUES ($1,$2,$3,$4,'INACTIVE',$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17)`,
      [cutoverId, principal.organizationId, current.lineage_id, current.version + 1,
        current.reconciliation_session_id, current.predecessor_account_combination_id,
        current.successor_account_combination_id, current.effective_on, command.effectiveFrom,
        current.id, JSON.stringify(current.migration_journal_line_ids), JSON.stringify(current.proof_snapshot),
        current.confirmation_hash, command.reason, command.idempotencyKey, commandHash, principal.userId],
    );
    return { cutoverId, lineageId: current.lineage_id, version: current.version + 1, state: "INACTIVE", effectiveFrom: command.effectiveFrom, idempotentReplay: false };
  });
}

export async function listBankAccountCutovers(input: Readonly<{
  principal: SessionPrincipal; requestId: string;
}> & z.input<typeof bankCutoverListSchema>) {
  const { principal, requestId, ...raw } = input;
  const filter = bankCutoverListSchema.parse(raw);
  return withCutoverRead({ principal, requestId }, async (client) => {
    const result = await client.query(
      `SELECT cutover.id AS "cutoverId", cutover.lineage_id AS "lineageId",
         cutover.version, cutover.state,
         cutover.reconciliation_session_id AS "reconciliationId",
         cutover.predecessor_account_combination_id AS "predecessorAccountCombinationId",
         cutover.successor_account_combination_id AS "successorAccountCombinationId",
         cutover.effective_on::text AS "effectiveOn",
         cutover.lifecycle_effective_on::text AS "lifecycleEffectiveOn",
         cutover.supersedes_cutover_id AS "supersedesCutoverId",
         cutover.migration_journal_line_ids AS "migrationJournalLineIds",
         cutover.proof_snapshot AS proof, cutover.confirmation_hash AS "confirmationHash",
         cutover.reason, cutover.created_by AS "createdBy", cutover.created_at::text AS "createdAt",
         NOT EXISTS (SELECT 1 FROM bank_account_cutovers successor
           WHERE successor.organization_id=cutover.organization_id
             AND successor.supersedes_cutover_id=cutover.id) AS current
       FROM bank_account_cutovers cutover
       WHERE cutover.organization_id=$1
         AND ($2::uuid IS NULL OR cutover.reconciliation_session_id=$2::uuid)
         AND ($3::uuid IS NULL OR cutover.lineage_id=$3::uuid)
       ORDER BY cutover.lineage_id, cutover.version`,
      [principal.organizationId, filter.reconciliationId ?? null, filter.lineageId ?? null],
    );
    return { cutovers: result.rows };
  });
}
