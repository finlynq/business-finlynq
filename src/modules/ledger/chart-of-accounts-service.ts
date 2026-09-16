import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";

export const createGlAccountSchema = z.object({
  ledgerId: z.uuid(),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/),
  displayName: z.string().trim().min(1).max(200),
  accountClass: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]),
  controlKind: z.enum(["NONE", "AR", "AP"]).default("NONE"),
  postable: z.boolean().default(true),
  validFrom: z.iso.date(),
  validTo: z.iso.date().nullable().optional(),
  createDefaultCombination: z.boolean().default(false),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export const updateGlAccountSchema = z.object({
  accountId: z.uuid(),
  displayName: z.string().trim().min(1).max(200),
  postable: z.boolean(),
  active: z.boolean(),
  validFrom: z.iso.date(),
  validTo: z.iso.date().nullable(),
  expected: z.object({
    displayName: z.string().trim().min(1).max(200),
    postable: z.boolean(),
    active: z.boolean(),
    validFrom: z.iso.date(),
    validTo: z.iso.date().nullable(),
  }).strict(),
  reason: z.string().trim().min(5).max(500),
}).strict();

export class GlAccountValidityConflictError extends Error {
  readonly code = "GL_ACCOUNT_VALID_FROM_CONFLICT";
  readonly safeDetails: Readonly<{
    earliestConflictingAccountingDate: string;
    dependencyCounts: Readonly<{
      journalLines: number;
      sourceDocuments: number;
      bankMappings: number;
    }>;
  }>;

  constructor(details: GlAccountValidityConflictError["safeDetails"]) {
    super(
      `The account cannot start after ${details.earliestConflictingAccountingDate} because earlier accounting dependencies exist.`,
    );
    this.name = "GlAccountValidityConflictError";
    this.safeDetails = details;
  }
}

export function glAccountValidityConflictDetails(error: unknown) {
  if (!(error instanceof GlAccountValidityConflictError)) return null;
  return {
    code: error.code,
    message: error.message,
    details: error.safeDetails,
  } as const;
}

async function assertAccountPermission(context: TenantTransactionContext, client: Parameters<Parameters<typeof withTenantTransaction>[1]>[0]) {
  await assertActorHasActivePermission(client, {
    organizationId: context.organizationId,
    actorId: context.actorId,
    permission: PERMISSIONS.manageSegments,
  });
}

export async function createGlAccount(input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof createGlAccountSchema>) {
  assertTenantWritesEnabled(input.context);
  const { context, ...unparsedCommand } = input;
  void context;
  const command = createGlAccountSchema.parse(unparsedCommand);
  return withTenantTransaction(input.context, async (client) => {
    await assertWritableOrganization(client, input.context);
    await assertAccountPermission(input.context, client);
    const ledger = await client.query<{ legal_entity_id: string }>(
      `SELECT legal_entity_id FROM ledgers
       WHERE organization_id = $1 AND id = $2 AND active`,
      [input.context.organizationId, command.ledgerId],
    );
    const selectedLedger = ledger.rows[0];
    if (!selectedLedger) throw new Error("An active tenant ledger is required");
    if (command.validTo && command.validTo < command.validFrom) throw new Error("Account valid-to date cannot precede valid-from date");
    const existing = await client.query<{
      id: string;
      display_name: string;
      class: string;
      control_kind: string;
      postable: boolean;
      valid_from: string;
      valid_to: string | null;
    }>(
      `SELECT id, display_name, class::text, control_kind::text, postable,
         valid_from::text, valid_to::text
       FROM gl_accounts
       WHERE organization_id = $1 AND ledger_id = $2 AND code = $3
       FOR SHARE`,
      [input.context.organizationId, command.ledgerId, command.code],
    );
    let accountId: string;
    let idempotentReplay: boolean;
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.display_name !== command.displayName || row.class !== command.accountClass ||
          row.control_kind !== command.controlKind || row.postable !== command.postable ||
          row.valid_from !== command.validFrom || row.valid_to !== (command.validTo ?? null)) {
        throw new Error("Account code is already bound to different chart-of-accounts data");
      }
      accountId = row.id;
      idempotentReplay = true;
    } else {
      accountId = randomUUID();
      const result = await client.query<{ id: string; code: string }>(
        `INSERT INTO gl_accounts (
           id, organization_id, ledger_id, code, display_name, class,
           control_kind, postable, active, valid_from, valid_to
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10)
         RETURNING id, code`,
        [
          accountId,
          input.context.organizationId,
          command.ledgerId,
          command.code,
          command.displayName,
          command.accountClass,
          command.controlKind,
          command.postable,
          command.validFrom,
          command.validTo ?? null,
        ],
      );
      if (!result.rows[0]) throw new Error("General-ledger account was not created");
      idempotentReplay = false;
    }

    let accountCombinationId: string | null = null;
    if (command.createDefaultCombination) {
      const combination = await client.query<{ id: string }>(
        `SELECT (created).id
         FROM (
           SELECT app.accounting_create_account_combination(
             $1::uuid,$2::uuid,$3::uuid,
             NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
           ) AS created
         ) mutation`,
        [selectedLedger.legal_entity_id, command.ledgerId, accountId],
      );
      accountCombinationId = combination.rows[0]?.id ?? null;
      if (!accountCombinationId) {
        throw new Error("The account and its default combination were not created atomically");
      }
    }
    return {
      accountId,
      code: command.code,
      idempotentReplay,
      ...(accountCombinationId ? { accountCombinationId } : {}),
    };
  });
}

export async function updateGlAccount(input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof updateGlAccountSchema>) {
  assertTenantWritesEnabled(input.context);
  const { context, ...unparsedCommand } = input;
  void context;
  const command = updateGlAccountSchema.parse(unparsedCommand);
  if (input.context.reason !== command.reason) throw new Error("Account-change reason must be bound to the transaction audit context");
  return withTenantTransaction(input.context, async (client) => {
    await assertWritableOrganization(client, input.context);
    await assertAccountPermission(input.context, client);
    const currentResult = await client.query<{
      id: string;
      ledger_id: string;
      display_name: string;
      postable: boolean;
      active: boolean;
      valid_from: string;
      valid_to: string | null;
    }>(
      `SELECT id, ledger_id, display_name, postable, active,
         valid_from::text, valid_to::text
       FROM gl_accounts
       WHERE organization_id = $1 AND id = $2
       FOR UPDATE`,
      [input.context.organizationId, command.accountId],
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new Error("Account changed after it was loaded, is outside this organization, or violates a protected mapping");
    }
    const matchesExpected = current.display_name === command.expected.displayName &&
      current.postable === command.expected.postable && current.active === command.expected.active &&
      current.valid_from === command.expected.validFrom && current.valid_to === command.expected.validTo;
    const matchesRequested = current.display_name === command.displayName &&
      current.postable === command.postable && current.active === command.active &&
      current.valid_from === command.validFrom && current.valid_to === command.validTo;
    if (!matchesExpected) {
      if (matchesRequested) {
        return {
          accountId: current.id,
          displayName: current.display_name,
          postable: current.postable,
          active: current.active,
          validFrom: current.valid_from,
          validTo: current.valid_to,
          idempotentReplay: true,
          impactPreview: { combinationCount: 0, combinations: [] },
        };
      }
      throw new Error("Account changed after it was loaded, is outside this organization, or violates a protected mapping");
    }
    if (command.validTo && command.validTo < command.validFrom) {
      throw new Error("Account valid-to date cannot precede valid-from date");
    }

    if (command.validFrom > current.valid_from) {
      const conflicts = await client.query<{
        journal_line_count: number;
        source_document_count: number;
        bank_mapping_count: number;
        earliest_conflicting_date: string | null;
      }>(
        `WITH selected_combinations AS (
           SELECT id FROM account_combinations
           WHERE organization_id = $1 AND account_id = $2
         ), journal_dependencies AS (
           SELECT count(DISTINCT line.id)::integer AS dependency_count,
             min(entry.accounting_date)::text AS earliest_date
           FROM selected_combinations combination
           JOIN journal_lines line
             ON line.organization_id = $1
            AND line.account_combination_id = combination.id
           JOIN journal_entries entry
             ON entry.organization_id = line.organization_id
            AND entry.id = line.journal_entry_id
           WHERE entry.accounting_date < $3::date
         ), bank_dependencies AS (
           SELECT count(DISTINCT external.id)::integer AS dependency_count,
             min(external.created_at::date)::text AS earliest_date
           FROM selected_combinations combination
           JOIN bank_external_accounts external
             ON external.organization_id = $1
            AND external.cash_account_combination_id = combination.id
           WHERE external.created_at::date < $3::date
         ), document_dependencies AS (
           SELECT count(DISTINCT document.id)::integer AS dependency_count,
             min((document.snapshot->>'accountingDate')::date)::text AS earliest_date
           FROM source_documents document
           WHERE document.organization_id = $1
             AND (document.snapshot->>'accountingDate')::date < $3::date
             AND EXISTS (
               SELECT 1
               FROM selected_combinations combination
               WHERE document.snapshot->>'controlAccountCombinationId' = combination.id::text
                 OR document.snapshot->>'taxAccountCombinationId' = combination.id::text
                 OR document.snapshot->>'fxRoundingAccountCombinationId' = combination.id::text
                 OR document.snapshot->>'bankAccountCombinationId' = combination.id::text
                 OR document.snapshot->>'settlementAccountCombinationId' = combination.id::text
                 OR document.snapshot->>'realizedFxGainAccountCombinationId' = combination.id::text
                 OR document.snapshot->>'realizedFxLossAccountCombinationId' = combination.id::text
                 OR EXISTS (
                   SELECT 1 FROM jsonb_array_elements(
                     coalesce(document.snapshot->'lines', '[]'::jsonb)
                   ) line
                   WHERE line->>'accountCombinationId' = combination.id::text
                 )
             )
         )
         SELECT journal_dependencies.dependency_count AS journal_line_count,
           document_dependencies.dependency_count AS source_document_count,
           bank_dependencies.dependency_count AS bank_mapping_count,
           least(journal_dependencies.earliest_date, document_dependencies.earliest_date,
             bank_dependencies.earliest_date)
             AS earliest_conflicting_date
         FROM journal_dependencies
         CROSS JOIN document_dependencies
         CROSS JOIN bank_dependencies`,
        [input.context.organizationId, command.accountId, command.validFrom],
      );
      const conflict = conflicts.rows[0];
      const journalLines = Number(conflict?.journal_line_count ?? 0);
      const sourceDocuments = Number(conflict?.source_document_count ?? 0);
      const bankMappings = Number(conflict?.bank_mapping_count ?? 0);
      if (journalLines > 0 || sourceDocuments > 0 || bankMappings > 0) {
        throw new GlAccountValidityConflictError({
          earliestConflictingAccountingDate: conflict?.earliest_conflicting_date ?? current.valid_from,
          dependencyCounts: { journalLines, sourceDocuments, bankMappings },
        });
      }
    }

    const result = await client.query<{
      id: string;
      display_name: string;
      postable: boolean;
      active: boolean;
      valid_from: string;
      valid_to: string | null;
    }>(
      `UPDATE gl_accounts
       SET display_name = $1, postable = $2, active = $3,
         valid_from = $4::date, valid_to = $5::date
       WHERE organization_id = $6 AND id = $7
       RETURNING id, display_name, postable, active, valid_from::text, valid_to::text`,
      [
        command.displayName,
        command.postable,
        command.active,
        command.validFrom,
        command.validTo,
        input.context.organizationId,
        command.accountId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Account changed after it was loaded, is outside this organization, or violates a protected mapping");
    const impact = await client.query<{
      id: string;
      previous_valid_from: string;
      effective_valid_from: string;
    }>(
      `SELECT combination.id,
         greatest(
           $3::date,
           coalesce(subaccount.valid_from, $3::date),
           coalesce(department.valid_from, $3::date),
           coalesce(custom1.valid_from, $3::date), coalesce(custom2.valid_from, $3::date),
           coalesce(custom3.valid_from, $3::date), coalesce(custom4.valid_from, $3::date),
           coalesce(custom5.valid_from, $3::date), coalesce(custom6.valid_from, $3::date),
           coalesce(custom7.valid_from, $3::date), coalesce(custom8.valid_from, $3::date)
         )::text AS previous_valid_from,
         greatest(
           $4::date,
           coalesce(subaccount.valid_from, $4::date),
           coalesce(department.valid_from, $4::date),
           coalesce(custom1.valid_from, $4::date), coalesce(custom2.valid_from, $4::date),
           coalesce(custom3.valid_from, $4::date), coalesce(custom4.valid_from, $4::date),
           coalesce(custom5.valid_from, $4::date), coalesce(custom6.valid_from, $4::date),
           coalesce(custom7.valid_from, $4::date), coalesce(custom8.valid_from, $4::date)
         )::text AS effective_valid_from
       FROM account_combinations combination
       LEFT JOIN segment_values subaccount ON subaccount.id = combination.subaccount_id
       LEFT JOIN segment_values department ON department.id = combination.department_id
       LEFT JOIN segment_values custom1 ON custom1.id = combination.custom_1_id
       LEFT JOIN segment_values custom2 ON custom2.id = combination.custom_2_id
       LEFT JOIN segment_values custom3 ON custom3.id = combination.custom_3_id
       LEFT JOIN segment_values custom4 ON custom4.id = combination.custom_4_id
       LEFT JOIN segment_values custom5 ON custom5.id = combination.custom_5_id
       LEFT JOIN segment_values custom6 ON custom6.id = combination.custom_6_id
       LEFT JOIN segment_values custom7 ON custom7.id = combination.custom_7_id
       LEFT JOIN segment_values custom8 ON custom8.id = combination.custom_8_id
       WHERE combination.organization_id = $1 AND combination.account_id = $2
       ORDER BY combination.created_at, combination.id`,
      [input.context.organizationId, command.accountId, current.valid_from, command.validFrom],
    );
    const affectedCombinations = impact.rows.filter((combination) =>
      combination.previous_valid_from !== combination.effective_valid_from
    );
    await client.query(
      `SELECT app.append_tenant_business_audit(
         $1::uuid, 'accounting.gl_account.updated', 'gl_account', $2,
         jsonb_build_object(
           'displayNameFrom', $3::text, 'displayNameTo', $4::text,
           'validFromFrom', $5::date, 'validFromTo', $6::date,
           'validToFrom', $7::date, 'validToTo', $8::date,
           'postableFrom', $9::boolean, 'postableTo', $10::boolean,
           'activeFrom', $11::boolean, 'activeTo', $12::boolean,
           'affectedCombinationCount', $13::integer
         ),
         'ledger.gl-account-updated'
       )`,
      [
        input.context.organizationId,
        row.id,
        current.display_name,
        row.display_name,
        current.valid_from,
        row.valid_from,
        current.valid_to,
        row.valid_to,
        current.postable,
        row.postable,
        current.active,
        row.active,
        affectedCombinations.length,
      ],
    );
    return {
      accountId: row.id,
      displayName: row.display_name,
      postable: row.postable,
      active: row.active,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      idempotentReplay: false,
      impactPreview: {
        combinationCount: affectedCombinations.length,
        combinations: affectedCombinations.map((combination) => ({
          id: combination.id,
          previousValidFrom: combination.previous_valid_from,
          effectiveValidFrom: combination.effective_valid_from,
        })),
      },
    };
  });
}
