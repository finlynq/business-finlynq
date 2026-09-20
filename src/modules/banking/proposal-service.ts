import "server-only";

import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction } from "@/db/transaction";
import { createCommandFingerprint } from "@/kernel/command-fingerprint";
import { isQuantizedMoney } from "@/kernel/money";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import type { SessionPrincipal } from "@/modules/identity/session";
import { createManualJournal } from "@/modules/ledger/journal-service";
import { assertTenantWritesEnabled, assertWritableOrganization, mutationContext, principalCanWrite } from "@/modules/workspace/write-policy";
import { BankingServiceError } from "./banking-error";

const exactAmount = z.string().trim().regex(/^\d+(?:\.\d{1,9})?$/);
const lineSchema = z.object({
  accountCombinationId: z.uuid(),
  debitFunctional: exactAmount,
  creditFunctional: exactAmount,
  transactionCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  debitTransaction: exactAmount,
  creditTransaction: exactAmount,
  fxRate: z.string().trim().regex(/^\d+(?:\.\d{1,18})?$/),
  fxRateSource: z.string().trim().min(1).max(100),
  fxRateEffectiveAt: z.iso.datetime({ offset: true }),
  memo: z.string().trim().max(500).optional(),
}).strict();

export const prepareBankAccountingProposalSchema = z.object({
  observationVersionId: z.uuid(),
  legalEntityId: z.uuid(),
  ledgerId: z.uuid(),
  periodId: z.uuid(),
  accountingDate: z.iso.date(),
  purpose: z.enum(["ROUTINE", "ADJUSTING", "OPENING", "TAX_ADJUSTMENT"]),
  transactionType: z.enum(["EXPENSE", "INCOME", "TRANSFER", "SETTLEMENT", "OTHER"]),
  partyAccountId: z.uuid().optional(),
  description: z.string().trim().min(1).max(500),
  lines: z.array(lineSchema).min(2).max(50),
  taxEvidence: z.object({ taxRegistrationId: z.uuid(), rule: z.string().min(1).max(200), basis: z.string().min(1).max(200), rate: z.string().min(1).max(50), recoverability: z.string().min(1).max(200), evidence: z.string().min(1).max(500) }).strict().optional(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  warnings: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  duplicateReferences: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  transferObservationVersionIds: z.array(z.uuid()).max(2).default([]),
  reason: z.string().trim().min(8).max(500),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict().superRefine((value, context) => {
  if (value.transactionType === "TRANSFER" && value.transferObservationVersionIds.length === 0) context.addIssue({ code: "custom", path: ["transferObservationVersionIds"], message: "Transfers require the exact counterpart observation" });
  if (value.transactionType !== "TRANSFER" && value.transferObservationVersionIds.length > 0) context.addIssue({ code: "custom", path: ["transferObservationVersionIds"], message: "Counterpart observations are allowed only for transfers" });
  if (value.confidence !== "HIGH" && value.warnings.length === 0) context.addIssue({ code: "custom", path: ["warnings"], message: "Medium and low confidence proposals require a review warning" });
});

export const decideBankAccountingProposalSchema = z.object({
  proposalId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  expectedProposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["REVIEW", "REJECT"]),
  reason: z.string().trim().min(8).max(500),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export const commitBankAccountingProposalSchema = z.object({
  proposalId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  expectedProposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(8).max(500),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export const getBankAccountingProposalSchema = z.object({
  proposalId: z.uuid(),
}).strict();

type ProposalSnapshot = z.output<typeof prepareBankAccountingProposalSchema>;

function proposalHash(snapshot: unknown): string {
  return createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex");
}

async function withProposalWrite<T>(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  reason: string;
  permission: typeof PERMISSIONS.prepareBankReconciliation | typeof PERMISSIONS.reviewBankReconciliation | typeof PERMISSIONS.draftJournal;
}>, work: (client: PoolClient) => Promise<T>) {
  if (!principalCanWrite(input.principal)) throw new BankingServiceError("A writable organization session is required.", 403, "WRITES_DISABLED");
  const context = mutationContext(input.principal, input.requestId, { reason: input.reason, sourceSurface: "MCP" });
  assertTenantWritesEnabled(context);
  return withTenantTransaction(context, async (client) => {
    await assertWritableOrganization(client, context);
    await assertActorHasActivePermission(client, {
      organizationId: input.principal.organizationId,
      actorId: input.principal.userId,
      permission: input.permission,
    });
    return work(client);
  });
}

async function lockProposalIdentity(client: PoolClient, organizationId: string, identity: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:bank-proposal:' || $1::text || ':' || $2::text, 0))",
    [organizationId, identity],
  );
}

async function currentProposal(client: PoolClient, organizationId: string, proposalId: string) {
  const row = (await client.query<{
    id: string; observation_version_id: string; version: number; status: string;
    proposal_snapshot: ProposalSnapshot; proposal_hash: string; journal_entry_id: string | null;
  }>(
    `SELECT proposal.id, proposal.observation_version_id, proposal.version, proposal.status,
       proposal.proposal_snapshot, proposal.proposal_hash, proposal.journal_entry_id
     FROM bank_accounting_proposals proposal
     WHERE proposal.organization_id=$1 AND proposal.id=$2
       AND NOT EXISTS (SELECT 1 FROM bank_accounting_proposals successor
         WHERE successor.organization_id=proposal.organization_id AND successor.supersedes_proposal_id=proposal.id)`,
    [organizationId, proposalId],
  )).rows[0];
  if (!row) throw new BankingServiceError("Choose the exact current proposal version.", 404, "BANK_PROPOSAL_NOT_FOUND");
  return row;
}

async function appendProposalVersion(input: Readonly<{
  client: PoolClient; principal: SessionPrincipal; previous: Awaited<ReturnType<typeof currentProposal>>;
  status: "REVIEWED" | "REJECTED" | "COMMITTED"; reason: string; idempotencyKey: string;
  commandHash: string; journalEntryId?: string;
}>) {
  const id = randomUUID();
  const version = input.previous.version + 1;
  await input.client.query(
    `INSERT INTO bank_accounting_proposals(
       id, organization_id, observation_version_id, version, status,
       proposal_snapshot, proposal_hash, supersedes_proposal_id, journal_entry_id,
       reason, idempotency_key, command_hash, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)`,
    [id, input.principal.organizationId, input.previous.observation_version_id,
      version, input.status, JSON.stringify(input.previous.proposal_snapshot),
      input.previous.proposal_hash, input.previous.id, input.journalEntryId ?? null,
      input.reason, input.idempotencyKey, input.commandHash, input.principal.userId],
  );
  return { proposalId: id, version, status: input.status, proposalHash: input.previous.proposal_hash, journalEntryId: input.journalEntryId ?? null };
}

export async function prepareBankAccountingProposal(input: Readonly<{ principal: SessionPrincipal; requestId: string }> & z.input<typeof prepareBankAccountingProposalSchema>) {
  const { principal, requestId, ...raw } = input;
  const command = prepareBankAccountingProposalSchema.parse(raw);
  const commandHash = createCommandFingerprint("banking.accounting-proposal.prepare", { ...command, idempotencyKey: undefined });
  return withProposalWrite({ principal, requestId, reason: command.reason, permission: PERMISSIONS.prepareBankReconciliation }, async (client) => {
    await lockProposalIdentity(client, principal.organizationId, command.observationVersionId);
    const replay = (await client.query<{ id: string; version: number; command_hash: string; proposal_hash: string }>(
      `SELECT id, version, command_hash, proposal_hash FROM bank_accounting_proposals WHERE organization_id=$1 AND idempotency_key=$2`,
      [principal.organizationId, command.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new BankingServiceError("The proposal idempotency key was used for different facts.", 409, "IDEMPOTENCY_CONFLICT");
      return { proposalId: replay.id, version: replay.version, status: "PREPARED" as const, proposalHash: replay.proposal_hash, idempotentReplay: true };
    }
    const observation = (await client.query<{
      amount: string; currency_code: string; external_account_id: string;
      posted_on: string; legal_entity_id: string; ledger_id: string; cash_account_combination_id: string;
    }>(
      `SELECT version.amount::text, version.currency_code, version.posted_on::text,
         observation.external_account_id,
         external.legal_entity_id, external.ledger_id, external.cash_account_combination_id
       FROM bank_observation_versions version JOIN bank_observations observation
         ON observation.organization_id=version.organization_id AND observation.id=version.observation_id
       JOIN bank_external_accounts external ON external.organization_id=observation.organization_id
         AND external.id=observation.external_account_id
       WHERE version.organization_id=$1 AND version.id=$2 AND version.status='POSTED'
         AND external.legal_entity_id IS NOT NULL AND external.ledger_id IS NOT NULL
         AND external.cash_account_combination_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM bank_observation_versions newer WHERE newer.organization_id=version.organization_id AND newer.observation_id=version.observation_id AND newer.version_number>version.version_number)
         AND NOT EXISTS (SELECT 1 FROM bank_match_allocations allocation
           JOIN bank_reconciliation_sessions reconciliation ON reconciliation.organization_id=allocation.organization_id AND reconciliation.id=allocation.reconciliation_session_id AND reconciliation.status<>'VOIDED'
           LEFT JOIN bank_match_allocation_voids void ON void.organization_id=allocation.organization_id AND void.allocation_id=allocation.id
           WHERE allocation.organization_id=version.organization_id AND allocation.observation_version_id=version.id AND void.id IS NULL)`,
      [principal.organizationId, command.observationVersionId],
    )).rows[0];
    if (!observation) throw new BankingServiceError("Choose a current unmatched posted bank observation.", 409, "BANK_PROPOSAL_OBSERVATION_UNAVAILABLE");
    if (observation.legal_entity_id !== command.legalEntityId || observation.ledger_id !== command.ledgerId) {
      throw new BankingServiceError("The proposal company and ledger must match the exact observed bank account mapping.", 400, "BANK_PROPOSAL_SCOPE_MISMATCH");
    }
    const accountingScope = (await client.query<{
      functional_currency: string; period_state: string; starts_on: string; ends_on: string;
    }>(
      `SELECT ledger.functional_currency, period.state AS period_state,
         period.starts_on::text, period.ends_on::text
       FROM ledgers ledger
       JOIN legal_entities entity ON entity.organization_id=ledger.organization_id
         AND entity.id=ledger.legal_entity_id AND entity.active
       JOIN fiscal_periods period ON period.organization_id=ledger.organization_id
         AND period.ledger_id=ledger.id
       WHERE ledger.organization_id=$1 AND ledger.id=$2 AND entity.id=$3
         AND period.id=$4 AND ledger.active`,
      [principal.organizationId, command.ledgerId, command.legalEntityId, command.periodId],
    )).rows[0];
    if (!accountingScope || !["OPEN", "ADJUSTMENT_ONLY"].includes(accountingScope.period_state) ||
        command.accountingDate < accountingScope.starts_on || command.accountingDate > accountingScope.ends_on) {
      throw new BankingServiceError("Choose an active company ledger and writable fiscal period containing the accounting date.", 400, "BANK_PROPOSAL_PERIOD_INVALID");
    }
    const existing = (await client.query(
      `SELECT 1 FROM bank_accounting_proposals proposal
       WHERE proposal.organization_id=$1 AND proposal.observation_version_id=$2
         AND NOT EXISTS (SELECT 1 FROM bank_accounting_proposals successor WHERE successor.organization_id=proposal.organization_id AND successor.supersedes_proposal_id=proposal.id)
         AND proposal.status<>'REJECTED'`,
      [principal.organizationId, command.observationVersionId],
    )).rows[0];
    if (existing) throw new BankingServiceError("This observation already has an active accounting proposal.", 409, "BANK_PROPOSAL_DUPLICATE");
    const duplicateEvidence = await client.query<{
      id: string; source_document_id: string | null; source_event_key: string;
    }>(
      `SELECT DISTINCT journal.id, journal.source_document_id, journal.source_event_key
       FROM journal_entries journal
       JOIN journal_lines line ON line.organization_id=journal.organization_id
         AND line.journal_entry_id=journal.id
       WHERE journal.organization_id=$1 AND journal.ledger_id=$2
         AND journal.accounting_date IN ($3::date,$7::date) AND journal.status<>'REVERSED'
         AND line.account_combination_id=$4
         AND line.transaction_currency=$5
         AND line.debit_transaction-line.credit_transaction=$6::numeric
       ORDER BY journal.id`,
      [principal.organizationId, command.ledgerId, command.accountingDate,
        observation.cash_account_combination_id, observation.currency_code, observation.amount,
        observation.posted_on],
    );
    if (duplicateEvidence.rows.some((row) => row.source_event_key.startsWith(`manual:bank-proposal:${command.observationVersionId}:`))) {
      throw new BankingServiceError("A source-linked journal already exists for this bank observation.", 409, "BANK_PROPOSAL_SOURCE_DUPLICATE");
    }
    const detectedDuplicateReferences = duplicateEvidence.rows.flatMap((row) => [
      `journal:${row.id}`,
      ...(row.source_document_id ? [`source-document:${row.source_document_id}`] : []),
    ]);
    const normalized: ProposalSnapshot = {
      ...command,
      duplicateReferences: [...new Set([...command.duplicateReferences, ...detectedDuplicateReferences])].sort(),
      warnings: detectedDuplicateReferences.length === 0
        ? command.warnings
        : [...new Set([...command.warnings, "Potential same-date, same-amount bank-line duplicates require explicit reviewer confirmation."])],
    };
    const contentHash = proposalHash(normalized);
    if (command.taxEvidence === undefined && command.lines.some((line) => line.memo?.toLowerCase().includes("tax"))) {
      throw new BankingServiceError("Tax-sensitive coding requires explicit rule, basis, rate, recoverability, and evidence.", 400, "BANK_PROPOSAL_TAX_EVIDENCE_REQUIRED");
    }
    for (const [index, line] of command.lines.entries()) {
      const debit = new Decimal(line.debitFunctional);
      const credit = new Decimal(line.creditFunctional);
      const transactionDebit = new Decimal(line.debitTransaction);
      const transactionCredit = new Decimal(line.creditTransaction);
      if (debit.isZero() === credit.isZero() || transactionDebit.isZero() === transactionCredit.isZero() ||
          debit.isPositive() !== transactionDebit.isPositive() || !new Decimal(line.fxRate).isPositive() ||
          !isQuantizedMoney(debit, accountingScope.functional_currency) ||
          !isQuantizedMoney(credit, accountingScope.functional_currency) ||
          !isQuantizedMoney(transactionDebit, line.transactionCurrency) ||
          !isQuantizedMoney(transactionCredit, line.transactionCurrency)) {
        throw new BankingServiceError(`Proposal line ${index + 1} needs one matching debit or credit side and a positive FX rate.`, 400, "BANK_PROPOSAL_LINE_INVALID");
      }
    }
    const debits = command.lines.reduce((sum, line) => sum.plus(line.debitFunctional), new Decimal(0));
    const credits = command.lines.reduce((sum, line) => sum.plus(line.creditFunctional), new Decimal(0));
    if (!debits.equals(credits) || debits.isZero()) throw new BankingServiceError("The proposed journal must be balanced and non-zero.", 400, "BANK_PROPOSAL_UNBALANCED");
    const transactionDebits = command.lines.reduce((sum, line) => sum.plus(line.debitTransaction), new Decimal(0));
    const transactionCredits = command.lines.reduce((sum, line) => sum.plus(line.creditTransaction), new Decimal(0));
    if (!transactionDebits.equals(transactionCredits)) throw new BankingServiceError("The proposal transaction-currency amounts must balance exactly.", 400, "BANK_PROPOSAL_TRANSACTION_UNBALANCED");
    if (!command.lines.every((line) => line.transactionCurrency === observation.currency_code)) throw new BankingServiceError("Proposal lines must retain the observation currency.", 400, "BANK_PROPOSAL_CURRENCY_MISMATCH");
    const cashLines = command.lines.filter((line) => line.accountCombinationId === observation.cash_account_combination_id);
    if (cashLines.length !== 1 || !new Decimal(cashLines[0]!.debitTransaction).minus(cashLines[0]!.creditTransaction).equals(observation.amount)) {
      throw new BankingServiceError("The proposal must contain exactly one mapped bank-account leg equal to the immutable observation amount.", 400, "BANK_PROPOSAL_BANK_LEG_MISMATCH");
    }
    const valid = (await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM account_combinations combination
       JOIN gl_accounts account ON account.organization_id=combination.organization_id
         AND account.ledger_id=combination.ledger_id AND account.id=combination.account_id
       WHERE combination.organization_id=$1 AND combination.entity_id=$2 AND combination.ledger_id=$3
         AND combination.id=ANY($4::uuid[]) AND combination.active
         AND account.active AND account.postable AND account.control_kind='NONE'`,
      [principal.organizationId, command.legalEntityId, command.ledgerId, command.lines.map((line) => line.accountCombinationId)],
    )).rows[0]?.count ?? 0;
    if (valid !== new Set(command.lines.map((line) => line.accountCombinationId)).size) throw new BankingServiceError("Every proposal line needs an exact active combination in the selected company ledger.", 400, "BANK_PROPOSAL_ACCOUNT_INVALID");
    if (command.partyAccountId) {
      const party = (await client.query(
        `SELECT 1 FROM party_accounts WHERE organization_id=$1 AND id=$2
           AND legal_entity_id=$3 AND ledger_id=$4 AND active`,
        [principal.organizationId, command.partyAccountId, command.legalEntityId, command.ledgerId],
      )).rows[0];
      if (!party) throw new BankingServiceError("Choose an exact active party account in the proposal company ledger.", 400, "BANK_PROPOSAL_PARTY_INVALID");
    }
    if (command.taxEvidence) {
      const registration = (await client.query(
        `SELECT 1 FROM entity_tax_registrations WHERE organization_id=$1 AND id=$2
           AND legal_entity_id=$3 AND valid_from<=$4::date
           AND (valid_to IS NULL OR valid_to>=$4::date)`,
        [principal.organizationId, command.taxEvidence.taxRegistrationId, command.legalEntityId, command.accountingDate],
      )).rows[0];
      if (!registration) throw new BankingServiceError("Tax-sensitive coding requires an exact effective tax registration in the proposal company.", 400, "BANK_PROPOSAL_TAX_REGISTRATION_INVALID");
    }
    if (command.transactionType === "TRANSFER") {
      if (command.transferObservationVersionIds.length !== 1 || command.transferObservationVersionIds[0] === command.observationVersionId) {
        throw new BankingServiceError("A transfer requires one distinct exact counterpart observation.", 400, "BANK_PROPOSAL_TRANSFER_INVALID");
      }
      const counterpart = (await client.query<{
        amount: string; currency_code: string; external_account_id: string;
        legal_entity_id: string | null; ledger_id: string | null; cash_account_combination_id: string | null;
      }>(
        `SELECT version.amount::text, version.currency_code, observation.external_account_id,
           external.legal_entity_id, external.ledger_id, external.cash_account_combination_id
         FROM bank_observation_versions version
         JOIN bank_observations observation ON observation.organization_id=version.organization_id AND observation.id=version.observation_id
         JOIN bank_external_accounts external ON external.organization_id=observation.organization_id
           AND external.id=observation.external_account_id
         WHERE version.organization_id=$1 AND version.id=$2 AND version.status='POSTED'
           AND NOT EXISTS (SELECT 1 FROM bank_observation_versions newer
             WHERE newer.organization_id=version.organization_id AND newer.observation_id=version.observation_id AND newer.version_number>version.version_number)
           AND NOT EXISTS (SELECT 1 FROM bank_match_allocations allocation
             JOIN bank_reconciliation_sessions reconciliation ON reconciliation.organization_id=allocation.organization_id AND reconciliation.id=allocation.reconciliation_session_id AND reconciliation.status<>'VOIDED'
             LEFT JOIN bank_match_allocation_voids void ON void.organization_id=allocation.organization_id AND void.allocation_id=allocation.id
             WHERE allocation.organization_id=version.organization_id AND allocation.observation_version_id=version.id AND void.id IS NULL)`,
        [principal.organizationId, command.transferObservationVersionIds[0]],
      )).rows[0];
      if (!counterpart || counterpart.external_account_id === observation.external_account_id ||
          counterpart.currency_code !== observation.currency_code ||
          counterpart.legal_entity_id !== command.legalEntityId || counterpart.ledger_id !== command.ledgerId ||
          counterpart.cash_account_combination_id === null ||
          !new Decimal(counterpart.amount).plus(observation.amount).isZero()) {
        throw new BankingServiceError("Transfer counterparts must be current unmatched observations on distinct accounts with equal and opposite currency amounts.", 400, "BANK_PROPOSAL_TRANSFER_INVALID");
      }
      const counterpartLines = command.lines.filter((line) => line.accountCombinationId === counterpart.cash_account_combination_id);
      if (counterpartLines.length !== 1 ||
          !new Decimal(counterpartLines[0]!.debitTransaction).minus(counterpartLines[0]!.creditTransaction).equals(counterpart.amount)) {
        throw new BankingServiceError("The transfer proposal must contain the exact mapped cash leg for its counterpart observation.", 400, "BANK_PROPOSAL_TRANSFER_LEG_MISMATCH");
      }
    }
    const proposalId = randomUUID();
    await client.query(
      `INSERT INTO bank_accounting_proposals(
         id, organization_id, observation_version_id, version, status,
         proposal_snapshot, proposal_hash, reason, idempotency_key, command_hash, created_by
       ) VALUES ($1,$2,$3,1,'PREPARED',$4::jsonb,$5,$6,$7,$8,$9)`,
      [proposalId, principal.organizationId, command.observationVersionId,
        JSON.stringify(normalized), contentHash, command.reason, command.idempotencyKey,
        commandHash, principal.userId],
    );
    return { proposalId, version: 1, status: "PREPARED" as const, proposalHash: contentHash, idempotentReplay: false };
  });
}

export async function decideBankAccountingProposal(input: Readonly<{ principal: SessionPrincipal; requestId: string }> & z.input<typeof decideBankAccountingProposalSchema>) {
  const { principal, requestId, ...raw } = input;
  const command = decideBankAccountingProposalSchema.parse(raw);
  const commandHash = createCommandFingerprint("banking.accounting-proposal.decide", { ...command, idempotencyKey: undefined });
  return withProposalWrite({ principal, requestId, reason: command.reason, permission: PERMISSIONS.reviewBankReconciliation }, async (client) => {
    await lockProposalIdentity(client, principal.organizationId, command.proposalId);
    const replay = (await client.query<{ id: string; version: number; status: "REVIEWED" | "REJECTED"; command_hash: string; proposal_hash: string }>(
      `SELECT id, version, status, command_hash, proposal_hash FROM bank_accounting_proposals WHERE organization_id=$1 AND idempotency_key=$2`,
      [principal.organizationId, command.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new BankingServiceError("The decision idempotency key was used for another request.", 409, "IDEMPOTENCY_CONFLICT");
      return { proposalId: replay.id, version: replay.version, status: replay.status, proposalHash: replay.proposal_hash, idempotentReplay: true };
    }
    const current = await currentProposal(client, principal.organizationId, command.proposalId);
    if (current.version !== command.expectedVersion || current.proposal_hash !== command.expectedProposalHash || current.status !== "PREPARED") throw new BankingServiceError("The proposal changed or is no longer awaiting review.", 409, "BANK_PROPOSAL_VERSION_CONFLICT");
    return { ...await appendProposalVersion({ client, principal, previous: current, status: command.decision === "REVIEW" ? "REVIEWED" : "REJECTED", reason: command.reason, idempotencyKey: command.idempotencyKey, commandHash }), idempotentReplay: false };
  });
}

export async function commitBankAccountingProposal(input: Readonly<{ principal: SessionPrincipal; requestId: string }> & z.input<typeof commitBankAccountingProposalSchema>) {
  const { principal, requestId, ...raw } = input;
  const command = commitBankAccountingProposalSchema.parse(raw);
  const commandHash = createCommandFingerprint("banking.accounting-proposal.commit", { ...command, idempotencyKey: undefined });
  return withProposalWrite({ principal, requestId, reason: command.reason, permission: PERMISSIONS.draftJournal }, async (client) => {
    await lockProposalIdentity(client, principal.organizationId, command.proposalId);
    const replay = (await client.query<{ id: string; version: number; command_hash: string; proposal_hash: string; journal_entry_id: string }>(
      `SELECT id, version, command_hash, proposal_hash, journal_entry_id FROM bank_accounting_proposals WHERE organization_id=$1 AND idempotency_key=$2`,
      [principal.organizationId, command.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new BankingServiceError("The commit idempotency key was used for another request.", 409, "IDEMPOTENCY_CONFLICT");
      return { proposalId: replay.id, version: replay.version, status: "COMMITTED" as const, proposalHash: replay.proposal_hash, journalEntryId: replay.journal_entry_id, matchingStatus: "AWAITING_POSTING" as const, idempotentReplay: true };
    }
    const proposal = await currentProposal(client, principal.organizationId, command.proposalId);
    if (proposal.version !== command.expectedVersion || proposal.proposal_hash !== command.expectedProposalHash || proposal.status !== "REVIEWED") throw new BankingServiceError("Only the exact reviewed proposal can create a draft.", 409, "BANK_PROPOSAL_VERSION_CONFLICT");
    const snapshot = prepareBankAccountingProposalSchema.parse(proposal.proposal_snapshot);
    const journal = await createManualJournal({
      context: mutationContext(principal, requestId, { reason: command.reason, sourceSurface: "MCP" }),
      ledgerId: snapshot.ledgerId,
      legalEntityId: snapshot.legalEntityId,
      periodId: snapshot.periodId,
      accountingDate: snapshot.accountingDate,
      purpose: snapshot.purpose,
      origin: "MCP",
      description: snapshot.description,
      idempotencyKey: `bank-proposal:${proposal.observation_version_id}:${command.idempotencyKey}`,
      lines: snapshot.lines,
    }, client);
    const committed = await appendProposalVersion({ client, principal, previous: proposal, status: "COMMITTED", reason: command.reason, idempotencyKey: command.idempotencyKey, commandHash, journalEntryId: journal.journalId });
    return { ...committed, matchingStatus: "AWAITING_POSTING" as const, idempotentReplay: false };
  });
}

export async function listBankAccountingProposals(principal: SessionPrincipal, filter: Readonly<{ observationVersionId?: string; proposalId?: string }> = {}) {
  const context = mutationContext(principal, `bank-proposals:${randomUUID()}`, { reason: "Read bank accounting proposals", sourceSurface: "MCP" });
  return withTenantTransaction(context, async (client) => {
    await assertActorHasActivePermission(client, { organizationId: principal.organizationId, actorId: principal.userId, permission: PERMISSIONS.readBanking });
    const result = await client.query(
      `SELECT proposal.id, proposal.observation_version_id AS "observationVersionId", proposal.version,
         proposal.status, proposal.proposal_snapshot AS snapshot, proposal.proposal_hash AS "proposalHash",
         proposal.supersedes_proposal_id AS "supersedesProposalId", proposal.journal_entry_id AS "journalEntryId",
         proposal.reason, proposal.created_by AS "createdBy", proposal.created_at::text AS "createdAt",
         NOT EXISTS (SELECT 1 FROM bank_accounting_proposals successor WHERE successor.organization_id=proposal.organization_id AND successor.supersedes_proposal_id=proposal.id) AS current
       FROM bank_accounting_proposals proposal WHERE proposal.organization_id=$1
         AND ($2::uuid IS NULL OR proposal.observation_version_id=$2)
         AND ($3::uuid IS NULL OR proposal.id=$3)
       ORDER BY proposal.observation_version_id, proposal.version`,
      [principal.organizationId, filter.observationVersionId ?? null, filter.proposalId ?? null],
    );
    return { proposals: result.rows };
  });
}

export async function getBankAccountingProposal(
  principal: SessionPrincipal,
  raw: z.input<typeof getBankAccountingProposalSchema>,
) {
  const command = getBankAccountingProposalSchema.parse(raw);
  const result = await listBankAccountingProposals(principal, { proposalId: command.proposalId });
  const proposal = result.proposals[0];
  if (!proposal) {
    throw new BankingServiceError(
      "The exact bank accounting proposal version was not found.",
      404,
      "BANK_PROPOSAL_NOT_FOUND",
    );
  }
  const history = await listBankAccountingProposals(principal, {
    observationVersionId: String(proposal.observationVersionId),
  });
  return { proposal, reviewHistory: history.proposals };
}
