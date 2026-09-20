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
  confirmationHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().trim().min(1).max(180),
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
  const [observations, predecessorLines, migrationLines] = await Promise.all([
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
    const replay = (await client.query<{ id: string; command_hash: string; confirmation_hash: string }>(
      `SELECT id, command_hash, confirmation_hash FROM bank_account_cutovers WHERE organization_id=$1 AND idempotency_key=$2`,
      [principal.organizationId, command.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new BankingServiceError("The cutover idempotency key was used for another declaration.", 409, "IDEMPOTENCY_CONFLICT");
      return { cutoverId: replay.id, confirmationHash: replay.confirmation_hash, idempotentReplay: true };
    }
    const current = await preview(client, principal.organizationId, command);
    if (current.confirmationHash !== command.confirmationHash) throw new BankingServiceError("The cutover proof changed. Preview and review the exact population again.", 409, "CUTOVER_CONFIRMATION_CONFLICT");
    if (current.proof.exceptions.length > 0) throw new BankingServiceError("Resolve every cutover proof exception before commit.", 409, "CUTOVER_PROOF_INCOMPLETE");
    const cutoverId = randomUUID();
    await client.query(
      `INSERT INTO bank_account_cutovers(
         id, organization_id, reconciliation_session_id, predecessor_account_combination_id,
         successor_account_combination_id, effective_on, migration_journal_line_ids,
         proof_snapshot, confirmation_hash, reason, idempotency_key, command_hash, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)`,
      [cutoverId, principal.organizationId, command.reconciliationId,
        command.predecessorAccountCombinationId, current.proof.successor.accountCombinationId,
        command.effectiveOn, JSON.stringify(command.migrationJournalLineIds),
        JSON.stringify(current.proof), command.confirmationHash, command.reason,
        command.idempotencyKey, commandHash, principal.userId],
    );
    return { cutoverId, confirmationHash: command.confirmationHash, proof: current.proof, idempotentReplay: false };
  });
}
