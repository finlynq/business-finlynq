import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import {
  createCommandFingerprint,
  matchesStoredCommandFingerprint,
  type TransitionalCommandFingerprints,
} from "@/kernel/command-fingerprint";
import { exact, isQuantizedMoney, sumExact } from "@/kernel/money";
import {
  actorHasActivePermission,
  assertActorHasActivePermission,
} from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { postJournalInTransaction } from "./posting-service";
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
} from "@/modules/workspace/write-policy";

const amountSchema = z.string().trim().regex(/^\d+(?:\.\d{1,9})?$/);
const rateSchema = z.string().trim().regex(/^\d+(?:\.\d{1,18})?$/);
const lineSchema = z.object({
  accountCombinationId: z.uuid(),
  debitFunctional: amountSchema,
  creditFunctional: amountSchema,
  transactionCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  debitTransaction: amountSchema,
  creditTransaction: amountSchema,
  fxRate: rateSchema,
  fxRateSource: z.string().trim().min(1).max(100),
  fxRateEffectiveAt: z.iso.datetime({ offset: true }),
  memo: z.string().trim().max(500).optional(),
});
const draftSchema = z.object({
  ledgerId: z.uuid(),
  legalEntityId: z.uuid(),
  periodId: z.uuid(),
  accountingDate: z.iso.date(),
  purpose: z.enum(["ROUTINE", "ADJUSTING", "OPENING", "CLOSING", "REVALUATION", "TAX_ADJUSTMENT"]),
  origin: z.enum(["USER", "API", "MCP"]).default("USER"),
  description: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(200),
  lines: z.array(lineSchema).min(2).max(200),
});
const reversalSchema = z.object({
  originalJournalId: z.uuid(),
  periodId: z.uuid(),
  accountingDate: z.iso.date(),
  description: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export type CreateManualJournalCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof draftSchema>;

export type ReverseJournalCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof reversalSchema>;

export type JournalCommandResult = Readonly<{
  journalId: string;
  status: "DRAFT" | "POSTED";
  journalNumber: number | null;
  idempotentReplay: boolean;
  autoPosted: boolean;
}>;

type JournalResultRow = Readonly<{
  id: string;
  command_hash: string;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "POSTED" | "REVERSED";
  journal_number: number | null;
}>;

function legacyCommandFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function journalCommandFingerprints(
  domain: "ledger.journal.manual-create" | "ledger.journal.full-reversal",
  value: unknown,
): TransitionalCommandFingerprints {
  return {
    current: createCommandFingerprint(domain, value),
    legacy: legacyCommandFingerprint(value),
  };
}

function assertLineAndJournalAmounts(
  lines: readonly z.output<typeof lineSchema>[],
  functionalCurrency: string,
): void {
  for (const [index, line] of lines.entries()) {
    const debit = exact(line.debitFunctional);
    const credit = exact(line.creditFunctional);
    const debitTransaction = exact(line.debitTransaction);
    const creditTransaction = exact(line.creditTransaction);
    const fxRate = exact(line.fxRate);
    if (debit.isZero() === credit.isZero()) {
      throw new Error(`Line ${index + 1} requires exactly one functional debit or credit side`);
    }
    if (debitTransaction.isZero() === creditTransaction.isZero()) {
      throw new Error(`Line ${index + 1} requires exactly one transaction debit or credit side`);
    }
    if (debit.greaterThan(0) !== debitTransaction.greaterThan(0)) {
      throw new Error(`Line ${index + 1} transaction side does not match its functional side`);
    }
    if (!fxRate.greaterThan(0)) throw new Error(`Line ${index + 1} FX rate must be positive`);
    if (!isQuantizedMoney(debit, functionalCurrency) || !isQuantizedMoney(credit, functionalCurrency)) {
      throw new Error(`Line ${index + 1} exceeds ${functionalCurrency} precision`);
    }
    if (!isQuantizedMoney(debitTransaction, line.transactionCurrency) ||
        !isQuantizedMoney(creditTransaction, line.transactionCurrency)) {
      throw new Error(`Line ${index + 1} exceeds ${line.transactionCurrency} precision`);
    }
  }
  const debits = sumExact(lines.map((line) => line.debitFunctional));
  const credits = sumExact(lines.map((line) => line.creditFunctional));
  if (debits.isZero() || !debits.equals(credits)) {
    throw new Error("Journal requires a non-zero exact functional debit/credit balance");
  }
}

function resultFromRow(row: JournalResultRow, idempotentReplay: boolean, autoPosted: boolean): JournalCommandResult {
  if (row.status !== "DRAFT" && row.status !== "POSTED") {
    throw new Error(`Idempotent journal replay is not available from status ${row.status}`);
  }
  return {
    journalId: row.id,
    status: row.status,
    journalNumber: row.journal_number,
    idempotentReplay,
    autoPosted,
  };
}

export async function createManualJournal(
  unparsedCommand: CreateManualJournalCommand,
): Promise<JournalCommandResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const command = draftSchema.parse(unparsedCommand);

  return withTenantTransaction(unparsedCommand.context, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    await assertActorHasActivePermission(client, {
      organizationId: unparsedCommand.context.organizationId,
      actorId: unparsedCommand.context.actorId,
      permission: PERMISSIONS.draftJournal,
    });

    const setup = await client.query<{
      functional_currency: string;
      period_state: "OPEN" | "ADJUSTMENT_ONLY" | "HARD_CLOSED" | "SEALED";
      starts_on: string;
      ends_on: string;
      journal_type_definition_id: string;
      journal_type_version: number;
      manual_mode: "REVIEW_REQUIRED" | "AUTO_POST";
    }>(
      `SELECT ledger.functional_currency,
         period.state AS period_state, period.starts_on::text, period.ends_on::text,
         journal_type.id AS journal_type_definition_id,
         journal_type.version AS journal_type_version,
         coalesce(policy.manual_mode, 'REVIEW_REQUIRED') AS manual_mode
       FROM ledgers ledger
       JOIN legal_entities entity
         ON entity.organization_id = ledger.organization_id
        AND entity.id = ledger.legal_entity_id AND entity.active
       JOIN fiscal_periods period
         ON period.organization_id = ledger.organization_id
        AND period.ledger_id = ledger.id
       JOIN LATERAL (
         SELECT id, version FROM journal_type_definitions
         WHERE key = 'ledger.manual' AND owner_module = 'ledger'
         ORDER BY version DESC LIMIT 1
       ) journal_type ON true
       LEFT JOIN ledger_posting_policies policy
         ON policy.organization_id = ledger.organization_id AND policy.ledger_id = ledger.id
       WHERE ledger.organization_id = $1 AND ledger.id = $2
         AND entity.id = $3 AND period.id = $4 AND ledger.active`,
      [
        unparsedCommand.context.organizationId,
        command.ledgerId,
        command.legalEntityId,
        command.periodId,
      ],
    );
    const configuration = setup.rows[0];
    if (!configuration) throw new Error("Ledger, entity, period, or manual journal type was not found");
    if (configuration.period_state === "HARD_CLOSED" || configuration.period_state === "SEALED") {
      throw new Error("Draft accounting date must use a period that can still accept posting");
    }
    if (command.accountingDate < configuration.starts_on || command.accountingDate > configuration.ends_on) {
      throw new Error("Accounting date is outside the selected fiscal period");
    }
    assertLineAndJournalAmounts(command.lines, configuration.functional_currency);

    const combinations = await client.query<{ id: string }>(
      `SELECT combination.id
       FROM account_combinations combination
       JOIN gl_accounts account
         ON account.organization_id = combination.organization_id
        AND account.ledger_id = combination.ledger_id
        AND account.id = combination.account_id
       WHERE combination.organization_id = $1
         AND combination.ledger_id = $2
         AND combination.entity_id = $3
         AND combination.id = ANY($4::uuid[])
         AND combination.active AND account.active AND account.postable
         AND account.control_kind = 'NONE'`,
      [
        unparsedCommand.context.organizationId,
        command.ledgerId,
        command.legalEntityId,
        [...new Set(command.lines.map((line) => line.accountCombinationId))],
      ],
    );
    const authorizedCombinations = new Set(combinations.rows.map((row) => row.id));
    if (command.lines.some((line) => !authorizedCombinations.has(line.accountCombinationId))) {
      throw new Error("Manual journals require active non-control accounts in the selected tenant ledger");
    }

    const fingerprints = journalCommandFingerprints("ledger.journal.manual-create", command);
    const journalId = randomUUID();
    const inserted = await client.query<JournalResultRow>(
      `INSERT INTO journal_entries (
         id, organization_id, ledger_id, legal_entity_id, period_id,
         journal_type_key, journal_type_definition_id, journal_type_version,
         source_event_key, idempotency_key, command_hash, origin, purpose,
         accounting_date, functional_currency, description, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, 'ledger.manual', $6, $7,
         $8, $9, $10, $11, $12, $13, $14, $15, $16
       )
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING id, command_hash, status, journal_number`,
      [
        journalId,
        unparsedCommand.context.organizationId,
        command.ledgerId,
        command.legalEntityId,
        command.periodId,
        configuration.journal_type_definition_id,
        configuration.journal_type_version,
        `manual:${command.idempotencyKey}`,
        command.idempotencyKey,
        fingerprints.current,
        command.origin,
        command.purpose,
        command.accountingDate,
        configuration.functional_currency,
        command.description,
        unparsedCommand.context.actorId,
      ],
    );
    if (!inserted.rows[0]) {
      const replay = await client.query<JournalResultRow>(
        `SELECT id, command_hash, status, journal_number
         FROM journal_entries
         WHERE organization_id = $1 AND idempotency_key = $2
         FOR SHARE`,
        [unparsedCommand.context.organizationId, command.idempotencyKey],
      );
      const existing = replay.rows[0];
      if (!existing || !matchesStoredCommandFingerprint(existing.command_hash, fingerprints)) {
        throw new Error("Idempotency key is already bound to a different journal command");
      }
      return resultFromRow(existing, true, false);
    }

    await client.query(
      `INSERT INTO journal_lines (
         id, organization_id, ledger_id, journal_entry_id, line_number,
         account_combination_id, debit_functional, credit_functional,
         transaction_currency, debit_transaction, credit_transaction,
         fx_rate, fx_rate_source, fx_rate_effective_at, memo
       )
       SELECT input.id, $1, $2, $3, input.line_number,
         input.account_combination_id, input.debit_functional, input.credit_functional,
         input.transaction_currency, input.debit_transaction, input.credit_transaction,
         input.fx_rate, input.fx_rate_source, input.fx_rate_effective_at, input.memo
       FROM unnest(
         $4::uuid[], $5::integer[], $6::uuid[], $7::numeric[], $8::numeric[],
         $9::text[], $10::numeric[], $11::numeric[], $12::numeric[], $13::text[],
         $14::timestamptz[], $15::text[]
       ) AS input(
         id, line_number, account_combination_id, debit_functional, credit_functional,
         transaction_currency, debit_transaction, credit_transaction, fx_rate,
         fx_rate_source, fx_rate_effective_at, memo
       )`,
      [
        unparsedCommand.context.organizationId,
        command.ledgerId,
        journalId,
        command.lines.map(() => randomUUID()),
        command.lines.map((_, index) => index + 1),
        command.lines.map((line) => line.accountCombinationId),
        command.lines.map((line) => line.debitFunctional),
        command.lines.map((line) => line.creditFunctional),
        command.lines.map((line) => line.transactionCurrency),
        command.lines.map((line) => line.debitTransaction),
        command.lines.map((line) => line.creditTransaction),
        command.lines.map((line) => line.fxRate),
        command.lines.map((line) => line.fxRateSource),
        command.lines.map((line) => line.fxRateEffectiveAt),
        command.lines.map((line) => line.memo ?? null),
      ],
    );

    const hasPostPermission = configuration.manual_mode === "AUTO_POST" &&
      await actorHasActivePermission(client, {
        organizationId: unparsedCommand.context.organizationId,
        actorId: unparsedCommand.context.actorId,
        permission: PERMISSIONS.postJournal,
      });
    const hasAdjustmentPermission = configuration.period_state !== "ADJUSTMENT_ONLY" ||
      await actorHasActivePermission(client, {
        organizationId: unparsedCommand.context.organizationId,
        actorId: unparsedCommand.context.actorId,
        permission: PERMISSIONS.postAdjustment,
      });
    const autoPost = configuration.manual_mode === "AUTO_POST" &&
      command.origin === "USER" && hasPostPermission && hasAdjustmentPermission;
    if (autoPost) {
      const posted = await postJournalInTransaction(client, {
        context: unparsedCommand.context,
        journalId,
      });
      return {
        journalId,
        status: "POSTED",
        journalNumber: posted.journalNumber,
        idempotentReplay: false,
        autoPosted: true,
      };
    }

    return resultFromRow(inserted.rows[0], false, false);
  });
}

export async function reversePostedJournal(
  unparsedCommand: ReverseJournalCommand,
): Promise<JournalCommandResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const command = reversalSchema.parse(unparsedCommand);
  if (unparsedCommand.context.reason !== command.reason) {
    throw new Error("Reversal reason must be bound to the transaction audit context");
  }

  return withTenantTransaction(unparsedCommand.context, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    await assertActorHasActivePermission(client, {
      organizationId: unparsedCommand.context.organizationId,
      actorId: unparsedCommand.context.actorId,
      permission: PERMISSIONS.reverseJournal,
    });
    const originalResult = await client.query<{
      id: string;
      ledger_id: string;
      legal_entity_id: string;
      functional_currency: string;
      status: string;
      owner_module: string;
      journal_type_key: string;
    }>(
      `SELECT entry.id, entry.ledger_id, entry.legal_entity_id,
         entry.functional_currency, entry.status, journal_type.owner_module,
         entry.journal_type_key
       FROM journal_entries entry
       JOIN journal_type_definitions journal_type
         ON journal_type.id = entry.journal_type_definition_id
        AND journal_type.key = entry.journal_type_key
        AND journal_type.version = entry.journal_type_version
       WHERE entry.organization_id = $1 AND entry.id = $2
       FOR UPDATE OF entry`,
      [unparsedCommand.context.organizationId, command.originalJournalId],
    );
    const original = originalResult.rows[0];
    if (!original || original.status !== "POSTED") {
      throw new Error("Only a posted journal in the authorized organization can be reversed");
    }
    if (original.owner_module !== "ledger") {
      throw new Error(`This journal must be corrected in its owning ${original.owner_module} module`);
    }
    if (original.journal_type_key !== "ledger.manual") {
      throw new Error("Only a posted ledger.manual journal can be reversed from the general ledger");
    }

    const fingerprints = journalCommandFingerprints("ledger.journal.full-reversal", command);
    const existingReversal = await client.query<JournalResultRow>(
      `SELECT reversal.id, reversal.command_hash, reversal.status, reversal.journal_number
       FROM journal_entry_relations relation
       JOIN journal_entries reversal
         ON reversal.organization_id = relation.organization_id
        AND reversal.id = relation.from_journal_id
       WHERE relation.organization_id = $1
         AND relation.to_journal_id = $2
         AND relation.kind = 'REVERSAL_OF'
       FOR SHARE OF reversal`,
      [unparsedCommand.context.organizationId, command.originalJournalId],
    );
    if (existingReversal.rows[0]) {
      const existing = existingReversal.rows[0];
      if (!matchesStoredCommandFingerprint(existing.command_hash, fingerprints)) {
        throw new Error("Journal already has a different full reversal");
      }
      return resultFromRow(existing, true, false);
    }

    const setup = await client.query<{
      journal_type_definition_id: string;
      journal_type_version: number;
    }>(
      `SELECT journal_type.id AS journal_type_definition_id,
         journal_type.version AS journal_type_version
       FROM fiscal_periods period
       JOIN LATERAL (
         SELECT id, version FROM journal_type_definitions
         WHERE key = 'ledger.reversal' AND owner_module = 'ledger'
         ORDER BY version DESC LIMIT 1
       ) journal_type ON true
       WHERE period.organization_id = $1 AND period.ledger_id = $2
         AND period.id = $3 AND period.state IN ('OPEN', 'ADJUSTMENT_ONLY')
         AND $4::date BETWEEN period.starts_on AND period.ends_on
       FOR SHARE OF period`,
      [
        unparsedCommand.context.organizationId,
        original.ledger_id,
        command.periodId,
        command.accountingDate,
      ],
    );
    const configuration = setup.rows[0];
    if (!configuration) throw new Error("Reversal date requires an allowed period in the original ledger");

    const reversalId = randomUUID();
    const inserted = await client.query<JournalResultRow>(
      `INSERT INTO journal_entries (
         id, organization_id, ledger_id, legal_entity_id, period_id,
         journal_type_key, journal_type_definition_id, journal_type_version,
         source_event_key, idempotency_key, command_hash, origin, purpose,
         accounting_date, functional_currency, description, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, 'ledger.reversal', $6, $7,
         $8, $9, $10, 'USER', 'REVERSAL', $11, $12, $13, $14
       )
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING id, command_hash, status, journal_number`,
      [
        reversalId,
        unparsedCommand.context.organizationId,
        original.ledger_id,
        original.legal_entity_id,
        command.periodId,
        configuration.journal_type_definition_id,
        configuration.journal_type_version,
        `reversal:${command.originalJournalId}`,
        command.idempotencyKey,
        fingerprints.current,
        command.accountingDate,
        original.functional_currency,
        command.description,
        unparsedCommand.context.actorId,
      ],
    );
    if (!inserted.rows[0]) {
      const replay = await client.query<JournalResultRow>(
        `SELECT id, command_hash, status, journal_number
         FROM journal_entries
         WHERE organization_id = $1 AND idempotency_key = $2
         FOR SHARE`,
        [unparsedCommand.context.organizationId, command.idempotencyKey],
      );
      if (!replay.rows[0] || !matchesStoredCommandFingerprint(replay.rows[0].command_hash, fingerprints)) {
        throw new Error("Idempotency key is already bound to a different journal command");
      }
      throw new Error("Reversal journal exists without its immutable reversal relation");
    }

    await client.query(
      `INSERT INTO journal_lines (
         id, organization_id, ledger_id, journal_entry_id, line_number,
         account_combination_id, debit_functional, credit_functional,
         transaction_currency, debit_transaction, credit_transaction,
         fx_rate, fx_rate_source, fx_rate_effective_at,
         party_account_id, subledger_event_id, tax_snapshot_id, memo
       )
       SELECT gen_random_uuid(), line.organization_id, line.ledger_id, $1,
         line.line_number, line.account_combination_id,
         line.credit_functional, line.debit_functional,
         line.transaction_currency, line.credit_transaction, line.debit_transaction,
         line.fx_rate, line.fx_rate_source, line.fx_rate_effective_at,
         line.party_account_id, line.subledger_event_id, line.tax_snapshot_id,
         coalesce(line.memo, '') || CASE WHEN line.memo IS NULL THEN '' ELSE ' · ' END || 'Full reversal'
       FROM journal_lines line
       WHERE line.organization_id = $2 AND line.journal_entry_id = $3
       ORDER BY line.line_number`,
      [reversalId, unparsedCommand.context.organizationId, original.id],
    );

    const posted = await postJournalInTransaction(client, {
      context: unparsedCommand.context,
      journalId: reversalId,
    });
    await client.query(
      `INSERT INTO journal_entry_relations (
         organization_id, from_journal_id, to_journal_id, kind, reason
       ) VALUES ($1, $2, $3, 'REVERSAL_OF', $4)`,
      [
        unparsedCommand.context.organizationId,
        reversalId,
        command.originalJournalId,
        command.reason,
      ],
    );
    return {
      journalId: reversalId,
      status: "POSTED",
      journalNumber: posted.journalNumber,
      idempotentReplay: false,
      autoPosted: false,
    };
  });
}
