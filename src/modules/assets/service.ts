import "server-only";

import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { quantizeMoney } from "@/kernel/money";
import {
  actorHasActivePermission,
  assertActorHasActivePermission,
} from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { transactionAuthMethod, type SessionPrincipal } from "@/modules/identity/session";
import { createManualJournal } from "@/modules/ledger/journal-service";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
  mutationContext,
  principalCanWrite,
} from "@/modules/workspace/write-policy";
import {
  assetAdjustmentSchema,
  calculateAssetSchedule,
  createAssetCategorySchema,
  createAssetRecordSchema,
  deactivateAssetCategorySchema,
  finiteScheduleEnd,
  reviseAssetCategorySchema,
  type AssetAdjustmentInput,
  type CreateAssetCategoryInput,
  type CreateAssetRecordInput,
  type DeactivateAssetCategoryInput,
  type ReviseAssetCategoryInput,
} from "./model";

export class AssetServiceError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
  ) {
    super(message);
    this.name = "AssetServiceError";
  }
}

function commandHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function withAssetWrite<T>(input: Readonly<{
  context: TenantTransactionContext;
  permission: typeof PERMISSIONS.draftJournal | typeof PERMISSIONS.manageOrganizationSettings;
}>, work: (client: PoolClient) => Promise<T>): Promise<T> {
  assertTenantWritesEnabled(input.context);
  return withTenantTransaction(input.context, async (client) => {
    await assertWritableOrganization(client, input.context);
    await assertActorHasActivePermission(client, {
      organizationId: input.context.organizationId,
      actorId: input.context.actorId,
      permission: input.permission,
    });
    return work(client);
  });
}

type CategoryRow = Readonly<{
  id: string;
  category_key: string;
  version: number;
  active: boolean;
  supersedes_category_id: string | null;
  effective_from: string;
  reason: string;
  legal_entity_id: string;
  ledger_id: string;
  kind: "TANGIBLE" | "INTANGIBLE" | "PREPAID";
  code: string;
  display_name: string;
  cost_account_combination_id: string;
  contra_account_combination_id: string | null;
  expense_account_combination_id: string;
  impairment_account_combination_id: string | null;
  disposal_account_combination_id: string | null;
  functional_currency: string;
}>;

async function loadCategory(
  client: PoolClient,
  organizationId: string,
  categoryId: string,
  allowInactive = false,
): Promise<CategoryRow> {
  const result = await client.query<CategoryRow>(
    `SELECT category.id, category.category_key, category.version, category.active,
       category.supersedes_category_id, category.effective_from::text, category.reason,
       category.legal_entity_id, category.ledger_id,
       category.kind, category.code, category.display_name,
       category.cost_account_combination_id, category.contra_account_combination_id,
       category.expense_account_combination_id,
       category.impairment_account_combination_id,
       category.disposal_account_combination_id, ledger.functional_currency
     FROM asset_categories category
     JOIN ledgers ledger
       ON ledger.organization_id = category.organization_id
      AND ledger.id = category.ledger_id AND ledger.active
     WHERE category.organization_id = $1 AND category.id = $2
       AND ($3::boolean OR category.active)
       AND NOT EXISTS (
         SELECT 1 FROM asset_categories successor
         WHERE successor.organization_id = category.organization_id
           AND successor.supersedes_category_id = category.id
       )`,
    [organizationId, categoryId, allowInactive],
  );
  const category = result.rows[0];
  if (!category) throw new AssetServiceError("The asset category is unavailable.", 404, "ASSET_CATEGORY_NOT_FOUND");
  return category;
}

async function validateCategoryMappings(
  client: PoolClient,
  organizationId: string,
  parsed: ReturnType<typeof createAssetCategorySchema.parse>,
): Promise<void> {
  const ids = [
    parsed.costAccountCombinationId,
    parsed.expenseAccountCombinationId,
    parsed.contraAccountCombinationId,
    parsed.impairmentAccountCombinationId,
    parsed.disposalAccountCombinationId,
  ].filter((value): value is string => Boolean(value));
  const accounts = await client.query<{ id: string; class: string }>(
    `SELECT combination.id, account.class::text
     FROM account_combinations combination
     JOIN gl_accounts account
       ON account.organization_id = combination.organization_id
      AND account.ledger_id = combination.ledger_id
      AND account.id = combination.account_id
     WHERE combination.organization_id = $1
       AND combination.entity_id = $2 AND combination.ledger_id = $3
       AND combination.id = ANY($4::uuid[])
       AND combination.active AND account.active AND account.postable
       AND account.control_kind = 'NONE'`,
    [organizationId, parsed.legalEntityId, parsed.ledgerId, ids],
  );
  if (accounts.rows.length !== new Set(ids).size) {
    throw new AssetServiceError("Every category mapping must use an active non-control account in the selected company ledger.", 400, "ASSET_ACCOUNT_MAPPING_INVALID");
  }
  const classes = new Map(accounts.rows.map((row) => [row.id, row.class]));
  if (classes.get(parsed.costAccountCombinationId) !== "ASSET" ||
      parsed.contraAccountCombinationId && classes.get(parsed.contraAccountCombinationId) !== "ASSET" ||
      classes.get(parsed.expenseAccountCombinationId) !== "EXPENSE" ||
      parsed.impairmentAccountCombinationId && classes.get(parsed.impairmentAccountCombinationId) !== "EXPENSE" ||
      parsed.disposalAccountCombinationId && classes.get(parsed.disposalAccountCombinationId) !== "EXPENSE") {
    throw new AssetServiceError("Cost and contra mappings must be asset accounts; expense, impairment, and disposal mappings must be expense accounts.", 400, "ASSET_ACCOUNT_CLASS_INVALID");
  }
}

function categorySemanticsMatch(row: CategoryRow, parsed: ReturnType<typeof createAssetCategorySchema.parse>): boolean {
  return row.legal_entity_id === parsed.legalEntityId && row.ledger_id === parsed.ledgerId &&
    row.kind === parsed.kind && row.code === parsed.code && row.display_name === parsed.displayName &&
    row.cost_account_combination_id === parsed.costAccountCombinationId &&
    row.contra_account_combination_id === (parsed.contraAccountCombinationId ?? null) &&
    row.expense_account_combination_id === parsed.expenseAccountCombinationId &&
    row.impairment_account_combination_id === (parsed.impairmentAccountCombinationId ?? null) &&
    row.disposal_account_combination_id === (parsed.disposalAccountCombinationId ?? null);
}

async function insertCategoryVersion(input: Readonly<{
  client: PoolClient;
  context: TenantTransactionContext;
  parsed: ReturnType<typeof createAssetCategorySchema.parse>;
  categoryKey: string;
  version: number;
  active: boolean;
  supersedesCategoryId: string | null;
}>) {
  const categoryId = randomUUID();
  const fingerprint = commandHash({
    ...input.parsed,
    idempotencyKey: undefined,
    categoryKey: input.categoryKey,
    version: input.version,
    active: input.active,
    supersedesCategoryId: input.supersedesCategoryId,
  });
  await input.client.query(
    `INSERT INTO asset_categories(
       id, organization_id, legal_entity_id, ledger_id, kind, category_key, code,
       display_name, cost_account_combination_id, contra_account_combination_id,
       expense_account_combination_id, impairment_account_combination_id,
       disposal_account_combination_id, active, version, supersedes_category_id,
       effective_from, reason, idempotency_key, command_hash, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [categoryId, input.context.organizationId, input.parsed.legalEntityId, input.parsed.ledgerId,
      input.parsed.kind, input.categoryKey, input.parsed.code, input.parsed.displayName,
      input.parsed.costAccountCombinationId, input.parsed.contraAccountCombinationId ?? null,
      input.parsed.expenseAccountCombinationId, input.parsed.impairmentAccountCombinationId ?? null,
      input.parsed.disposalAccountCombinationId ?? null, input.active, input.version,
      input.supersedesCategoryId, input.parsed.effectiveFrom, input.parsed.reason,
      input.parsed.idempotencyKey, fingerprint, input.context.actorId],
  );
  return { categoryId, categoryKey: input.categoryKey, version: input.version, active: input.active };
}

export async function createAssetCategory(input: Readonly<{
  context: TenantTransactionContext;
}> & CreateAssetCategoryInput) {
  const { context: _context, ...unparsed } = input;
  void _context;
  const parsed = createAssetCategorySchema.parse(unparsed);
  return withAssetWrite({ context: input.context, permission: PERMISSIONS.manageOrganizationSettings }, async (client) => {
    const replay = await client.query<CategoryRow>(
      `SELECT category.*, ledger.functional_currency FROM asset_categories category
       JOIN ledgers ledger ON ledger.organization_id=category.organization_id AND ledger.id=category.ledger_id
       WHERE category.organization_id = $1 AND category.idempotency_key = $2`,
      [input.context.organizationId, parsed.idempotencyKey],
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (row.version !== 1 || !row.active || row.supersedes_category_id !== null ||
          row.effective_from !== parsed.effectiveFrom || row.reason !== parsed.reason ||
          !categorySemanticsMatch(row, parsed)) {
        throw new AssetServiceError("This category idempotency key was already used for different facts.", 409, "ASSET_IDEMPOTENCY_CONFLICT");
      }
      return { categoryId: row.id, categoryKey: row.category_key, version: row.version, active: row.active, idempotentReplay: true };
    }
    const existing = await client.query<CategoryRow>(
      `SELECT category.*, ledger.functional_currency
       FROM asset_categories category
       JOIN ledgers ledger ON ledger.organization_id = category.organization_id AND ledger.id = category.ledger_id
       WHERE category.organization_id = $1 AND category.ledger_id = $2 AND category.code = $3
         AND NOT EXISTS (SELECT 1 FROM asset_categories successor
           WHERE successor.organization_id = category.organization_id AND successor.supersedes_category_id = category.id)
       ORDER BY category.version DESC LIMIT 1`,
      [input.context.organizationId, parsed.ledgerId, parsed.code],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].active && categorySemanticsMatch(existing.rows[0], parsed)) {
        return { categoryId: existing.rows[0].id, categoryKey: existing.rows[0].category_key, version: existing.rows[0].version, active: true, idempotentReplay: true };
      }
      throw new AssetServiceError("This category code already has different current semantics. Revise its exact current version instead.", 409, "ASSET_CATEGORY_CODE_CONFLICT");
    }
    await validateCategoryMappings(client, input.context.organizationId, parsed);
    return { ...await insertCategoryVersion({ client, context: input.context, parsed, categoryKey: randomUUID(), version: 1, active: true, supersedesCategoryId: null }), idempotentReplay: false };
  });
}

export async function previewAssetCategory(input: Readonly<{ context: TenantTransactionContext }> & CreateAssetCategoryInput) {
  const { context: _context, ...unparsed } = input;
  void _context;
  const parsed = createAssetCategorySchema.parse(unparsed);
  return withAssetWrite({ context: input.context, permission: PERMISSIONS.manageOrganizationSettings }, async (client) => {
    await validateCategoryMappings(client, input.context.organizationId, parsed);
    const current = await client.query<{ id: string; version: number; active: boolean }>(
      `SELECT category.id, category.version, category.active FROM asset_categories category
       WHERE category.organization_id=$1 AND category.ledger_id=$2 AND category.code=$3
         AND NOT EXISTS (SELECT 1 FROM asset_categories successor WHERE successor.organization_id=category.organization_id AND successor.supersedes_category_id=category.id)
       ORDER BY category.version DESC LIMIT 1`,
      [input.context.organizationId, parsed.ledgerId, parsed.code],
    );
    return { valid: true, current: current.rows[0] ?? null, proposed: parsed, writesPerformed: false };
  });
}

export async function reviseAssetCategory(input: Readonly<{ context: TenantTransactionContext }> & ReviseAssetCategoryInput) {
  const { context: _context, categoryId, expectedVersion, ...unparsed } = input;
  void _context;
  const parsedCommand = reviseAssetCategorySchema.parse({ categoryId, expectedVersion, ...unparsed });
  const parsed = createAssetCategorySchema.parse(unparsed);
  return withAssetWrite({ context: input.context, permission: PERMISSIONS.manageOrganizationSettings }, async (client) => {
    const replay = await client.query<CategoryRow>(
      `SELECT category.*, ledger.functional_currency FROM asset_categories category
       JOIN ledgers ledger ON ledger.organization_id=category.organization_id AND ledger.id=category.ledger_id
       WHERE category.organization_id=$1 AND category.idempotency_key=$2`,
      [input.context.organizationId, parsed.idempotencyKey],
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (!row.active || row.supersedes_category_id !== parsedCommand.categoryId ||
          row.version !== parsedCommand.expectedVersion + 1 || row.effective_from !== parsed.effectiveFrom ||
          row.reason !== parsed.reason || !categorySemanticsMatch(row, parsed)) {
        throw new AssetServiceError("This category idempotency key was already used for different revision facts.", 409, "ASSET_IDEMPOTENCY_CONFLICT");
      }
      return { categoryId: row.id, categoryKey: row.category_key, version: row.version, active: row.active, idempotentReplay: true };
    }
    const current = await loadCategory(client, input.context.organizationId, parsedCommand.categoryId, true);
    if (current.version !== parsedCommand.expectedVersion) throw new AssetServiceError("The category version is stale. Reload its current immutable version.", 409, "ASSET_CATEGORY_VERSION_CONFLICT");
    if (parsed.effectiveFrom <= current.effective_from) {
      throw new AssetServiceError("A category revision must become effective after the current version.", 400, "ASSET_CATEGORY_EFFECTIVE_DATE_INVALID");
    }
    if (current.ledger_id !== parsed.ledgerId || current.legal_entity_id !== parsed.legalEntityId || current.code !== parsed.code || current.kind !== parsed.kind) {
      throw new AssetServiceError("Category identity, company, ledger, code, and kind cannot change during revision.", 400, "ASSET_CATEGORY_IDENTITY_IMMUTABLE");
    }
    await validateCategoryMappings(client, input.context.organizationId, parsed);
    return { ...await insertCategoryVersion({ client, context: input.context, parsed, categoryKey: current.category_key, version: current.version + 1, active: true, supersedesCategoryId: current.id }), idempotentReplay: false };
  });
}

export async function deactivateAssetCategory(input: Readonly<{ context: TenantTransactionContext }> & DeactivateAssetCategoryInput) {
  const { context: _context, ...unparsed } = input;
  void _context;
  const command = deactivateAssetCategorySchema.parse(unparsed);
  return withAssetWrite({ context: input.context, permission: PERMISSIONS.manageOrganizationSettings }, async (client) => {
    const replay = await client.query<CategoryRow>(
      `SELECT category.*, ledger.functional_currency FROM asset_categories category
       JOIN ledgers ledger ON ledger.organization_id=category.organization_id AND ledger.id=category.ledger_id
       WHERE category.organization_id=$1 AND category.idempotency_key=$2`,
      [input.context.organizationId, command.idempotencyKey],
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (row.active || row.supersedes_category_id !== command.categoryId ||
          row.version !== command.expectedVersion + 1 || row.effective_from !== command.effectiveFrom ||
          row.reason !== command.reason) {
        throw new AssetServiceError("This category idempotency key was already used for different deactivation facts.", 409, "ASSET_IDEMPOTENCY_CONFLICT");
      }
      return { categoryId: row.id, categoryKey: row.category_key, version: row.version, active: false, idempotentReplay: true };
    }
    const current = await loadCategory(client, input.context.organizationId, command.categoryId);
    if (current.version !== command.expectedVersion) throw new AssetServiceError("The category version is stale. Reload its current immutable version.", 409, "ASSET_CATEGORY_VERSION_CONFLICT");
    if (command.effectiveFrom <= current.effective_from) {
      throw new AssetServiceError("A category deactivation must become effective after the current version.", 400, "ASSET_CATEGORY_EFFECTIVE_DATE_INVALID");
    }
    const parsed = createAssetCategorySchema.parse({
      legalEntityId: current.legal_entity_id, ledgerId: current.ledger_id, kind: current.kind,
      code: current.code, displayName: current.display_name,
      costAccountCombinationId: current.cost_account_combination_id,
      ...(current.contra_account_combination_id ? { contraAccountCombinationId: current.contra_account_combination_id } : {}),
      expenseAccountCombinationId: current.expense_account_combination_id,
      ...(current.impairment_account_combination_id ? { impairmentAccountCombinationId: current.impairment_account_combination_id } : {}),
      ...(current.disposal_account_combination_id ? { disposalAccountCombinationId: current.disposal_account_combination_id } : {}),
      effectiveFrom: command.effectiveFrom, reason: command.reason, idempotencyKey: command.idempotencyKey,
    });
    const dependency = await client.query<{ asset_count: number; schedule_count: number }>(
      `SELECT count(DISTINCT asset.id)::int AS asset_count, count(schedule.id)::int AS schedule_count
       FROM asset_register asset
       JOIN asset_categories category
         ON category.organization_id=asset.organization_id AND category.id=asset.category_id
       LEFT JOIN asset_schedule_entries schedule
         ON schedule.organization_id=asset.organization_id AND schedule.asset_id=asset.id
       WHERE asset.organization_id=$1 AND category.category_key=$2`,
      [input.context.organizationId, current.category_key],
    );
    return { ...await insertCategoryVersion({ client, context: input.context, parsed, categoryKey: current.category_key, version: current.version + 1, active: false, supersedesCategoryId: current.id }), dependencies: dependency.rows[0] ?? { asset_count: 0, schedule_count: 0 }, idempotentReplay: false };
  });
}

export async function createAssetRecord(input: Readonly<{
  context: TenantTransactionContext;
}> & CreateAssetRecordInput) {
  const { context: _context, ...unparsed } = input;
  void _context;
  const parsed = createAssetRecordSchema.parse(unparsed);
  const fingerprint = commandHash(parsed);
  return withAssetWrite({ context: input.context, permission: PERMISSIONS.draftJournal }, async (client) => {
    const replay = await client.query<{ id: string; command_hash: string }>(
      `SELECT id, command_hash FROM asset_register
       WHERE organization_id = $1 AND idempotency_key = $2`,
      [input.context.organizationId, parsed.idempotencyKey],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].command_hash !== fingerprint) {
        throw new AssetServiceError("This idempotency key was already used for different asset facts.", 409, "ASSET_IDEMPOTENCY_CONFLICT");
      }
      return { assetId: replay.rows[0].id, idempotentReplay: true };
    }
    const category = await loadCategory(client, input.context.organizationId, parsed.categoryId);
    if (category.effective_from > parsed.inServiceOn) {
      throw new AssetServiceError("The category version is not effective on the asset in-service date.", 400, "ASSET_CATEGORY_NOT_EFFECTIVE");
    }
    if (parsed.classification === "INDEFINITE_LIFE" && category.kind !== "INTANGIBLE") {
      throw new AssetServiceError("Only intangible assets can be classified as indefinite-life.", 400, "ASSET_CLASSIFICATION_INVALID");
    }
    if (category.kind === "PREPAID" && !parsed.scheduleEndOn) {
      throw new AssetServiceError("Prepaids require a coverage end date for daily partial-period allocation.", 400, "PREPAID_END_DATE_REQUIRED");
    }
    if (category.kind !== "PREPAID" && parsed.classification === "FINITE_LIFE" && !parsed.usefulLifeMonths) {
      throw new AssetServiceError("Finite-life tangible and intangible assets require a useful life in months.", 400, "ASSET_USEFUL_LIFE_REQUIRED");
    }
    const scheduleEndOn = parsed.classification === "INDEFINITE_LIFE"
      ? null
      : category.kind === "PREPAID"
        ? parsed.scheduleEndOn!
        : finiteScheduleEnd(parsed.inServiceOn, parsed.usefulLifeMonths!);
    const schedule = calculateAssetSchedule({
      kind: category.kind,
      classification: parsed.classification,
      inServiceOn: parsed.inServiceOn,
      scheduleEndOn: scheduleEndOn ?? undefined,
      usefulLifeMonths: parsed.usefulLifeMonths,
      cost: parsed.cost,
      residualValue: parsed.residualValue,
      currency: category.functional_currency,
    });
    const assetId = randomUUID();
    await client.query(
      `INSERT INTO asset_register(
         id, organization_id, category_id, legal_entity_id, ledger_id, kind,
         asset_number, display_name, description, classification,
         acquisition_date, in_service_on, schedule_end_on, cost, residual_value,
         useful_life_months, recognition_frequency, location, custodian,
         vendor_name, source_reference, evidence_asset_id, idempotency_key,
         command_hash, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
         $17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [assetId, input.context.organizationId, category.id, category.legal_entity_id,
        category.ledger_id, category.kind, parsed.assetNumber, parsed.displayName,
        parsed.description ?? null, parsed.classification, parsed.acquisitionDate,
        parsed.inServiceOn, scheduleEndOn, parsed.cost, parsed.residualValue,
        parsed.classification === "INDEFINITE_LIFE" ? null :
          parsed.usefulLifeMonths ?? schedule.length,
        parsed.recognitionFrequency, parsed.location ?? null, parsed.custodian ?? null,
        parsed.vendorName ?? null, parsed.sourceReference ?? null,
        parsed.evidenceAssetId ?? null, parsed.idempotencyKey, fingerprint,
        input.context.actorId],
    );
    for (const line of schedule) {
      await client.query(
        `INSERT INTO asset_schedule_entries(
           id, organization_id, asset_id, sequence_number, period_start_on,
           period_end_on, due_on, amount, idempotency_key
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [randomUUID(), input.context.organizationId, assetId, line.sequenceNumber,
          line.periodStartOn, line.periodEndOn, line.dueOn, line.amount,
          `asset-schedule:${assetId}:${line.sequenceNumber}`],
      );
    }
    await client.query(
      `INSERT INTO asset_lifecycle_events(
         organization_id, asset_id, event_type, effective_on, amount, details, created_by
       ) VALUES ($1,$2,'CREATED',$3,$4,$5::jsonb,$6),
         ($1,$2,'SCHEDULED',$3,NULL,$7::jsonb,$6)`,
      [input.context.organizationId, assetId, parsed.inServiceOn, parsed.cost,
        JSON.stringify({ categoryCode: category.code, sourceReference: parsed.sourceReference ?? null }),
        input.context.actorId,
        JSON.stringify({ scheduleEntryCount: schedule.length, scheduleEndOn, method: category.kind === "PREPAID" ? "DAILY_STRAIGHT_LINE_MONTHLY" : "STRAIGHT_LINE_MONTHLY" })],
    );
    return { assetId, scheduleEntryCount: schedule.length, scheduleEndOn, idempotentReplay: false };
  });
}

type ScheduleDraftFacts = Readonly<{
  schedule_id: string;
  schedule_status: string;
  journal_entry_id: string | null;
  asset_id: string;
  asset_number: string;
  asset_name: string;
  kind: "TANGIBLE" | "INTANGIBLE" | "PREPAID";
  legal_entity_id: string;
  ledger_id: string;
  functional_currency: string;
  period_id: string;
  due_on: string;
  amount: string;
  cost_account_combination_id: string;
  contra_account_combination_id: string | null;
  expense_account_combination_id: string;
}>;

async function scheduleDraftFacts(client: PoolClient, organizationId: string, scheduleEntryId: string): Promise<ScheduleDraftFacts> {
  const result = await client.query<ScheduleDraftFacts>(
    `SELECT schedule.id AS schedule_id, schedule.status AS schedule_status,
       schedule.journal_entry_id, asset.id AS asset_id,
       asset.asset_number, asset.display_name AS asset_name, asset.kind,
       asset.legal_entity_id, asset.ledger_id, ledger.functional_currency,
       period.id AS period_id, schedule.due_on::text, schedule.amount::text,
       category.cost_account_combination_id, category.contra_account_combination_id,
       category.expense_account_combination_id
     FROM asset_schedule_entries schedule
     JOIN asset_register asset
       ON asset.organization_id = schedule.organization_id AND asset.id = schedule.asset_id
     JOIN asset_categories category
       ON category.organization_id = asset.organization_id AND category.id = asset.category_id
     JOIN ledgers ledger
       ON ledger.organization_id = asset.organization_id AND ledger.id = asset.ledger_id
     JOIN fiscal_periods period
       ON period.organization_id = asset.organization_id AND period.ledger_id = asset.ledger_id
      AND schedule.due_on BETWEEN period.starts_on AND period.ends_on
     WHERE schedule.organization_id = $1 AND schedule.id = $2
       AND asset.status IN ('ACTIVE', 'IMPAIRED')
       AND period.state IN ('OPEN', 'ADJUSTMENT_ONLY')
     FOR UPDATE OF schedule`,
    [organizationId, scheduleEntryId],
  );
  const facts = result.rows[0];
  if (!facts) throw new AssetServiceError("The schedule entry is unavailable or its fiscal period is locked.", 409, "ASSET_SCHEDULE_UNAVAILABLE");
  return facts;
}

export async function generateAssetScheduleJournal(input: Readonly<{
  context: TenantTransactionContext;
  scheduleEntryId: string;
  idempotencyKey: string;
}>) {
  return withAssetWrite({ context: input.context, permission: PERMISSIONS.draftJournal }, async (client) => {
    const facts = await scheduleDraftFacts(client, input.context.organizationId, input.scheduleEntryId);
    if (facts.journal_entry_id) {
      return { journalId: facts.journal_entry_id, scheduleEntryId: facts.schedule_id, idempotentReplay: true };
    }
    const creditAccount = facts.kind === "PREPAID"
      ? facts.cost_account_combination_id
      : facts.contra_account_combination_id;
    if (!creditAccount) throw new AssetServiceError("The category is missing its contra account.", 409, "ASSET_CATEGORY_INCOMPLETE");
    const amount = quantizeMoney(facts.amount, facts.functional_currency).toFixed();
    const journal = await createManualJournal({
      context: input.context,
      ledgerId: facts.ledger_id,
      legalEntityId: facts.legal_entity_id,
      periodId: facts.period_id,
      accountingDate: facts.due_on,
      purpose: "ADJUSTING",
      origin: input.context.sourceSurface === "MCP" ? "MCP" : "API",
      description: `${facts.kind === "PREPAID" ? "Prepaid recognition" : facts.kind === "TANGIBLE" ? "Depreciation" : "Amortization"} · ${facts.asset_number} · ${facts.asset_name}`,
      idempotencyKey: `asset-schedule:${facts.schedule_id}:${input.idempotencyKey}`,
      lines: [{
        accountCombinationId: facts.expense_account_combination_id,
        debitFunctional: amount,
        creditFunctional: "0",
        transactionCurrency: facts.functional_currency,
        debitTransaction: amount,
        creditTransaction: "0",
        fxRate: "1",
        fxRateSource: "FUNCTIONAL_CURRENCY",
        fxRateEffectiveAt: `${facts.due_on}T12:00:00.000Z`,
        memo: `${facts.asset_number} schedule recognition`,
      }, {
        accountCombinationId: creditAccount,
        debitFunctional: "0",
        creditFunctional: amount,
        transactionCurrency: facts.functional_currency,
        debitTransaction: "0",
        creditTransaction: amount,
        fxRate: "1",
        fxRateSource: "FUNCTIONAL_CURRENCY",
        fxRateEffectiveAt: `${facts.due_on}T12:00:00.000Z`,
        memo: `${facts.asset_number} schedule recognition`,
      }],
    }, client);
    await client.query(
      `UPDATE asset_schedule_entries SET status = 'DRAFTED', journal_entry_id = $3,
         version = version + 1
       WHERE organization_id = $1 AND id = $2
         AND (journal_entry_id IS NULL OR journal_entry_id = $3)`,
      [input.context.organizationId, facts.schedule_id, journal.journalId],
    );
    await client.query(
      `INSERT INTO asset_lifecycle_events(
         organization_id, asset_id, event_type, effective_on, amount,
         details, journal_entry_id, created_by
       ) SELECT $1,$2,'DRAFT_CREATED',$3,$4,$5::jsonb,$6,$7
       WHERE NOT EXISTS (
         SELECT 1 FROM asset_lifecycle_events
         WHERE organization_id = $1 AND asset_id = $2
           AND event_type = 'DRAFT_CREATED' AND journal_entry_id = $6
       )`,
      [input.context.organizationId, facts.asset_id, facts.due_on, amount,
        JSON.stringify({ scheduleEntryId: facts.schedule_id }), journal.journalId,
        input.context.actorId],
    );
    return { journalId: journal.journalId, scheduleEntryId: facts.schedule_id, idempotentReplay: journal.idempotentReplay };
  });
}

type AssetAdjustmentFacts = Readonly<{
  asset_id: string;
  asset_number: string;
  display_name: string;
  status: string;
  kind: "TANGIBLE" | "INTANGIBLE" | "PREPAID";
  legal_entity_id: string;
  ledger_id: string;
  period_id: string;
  functional_currency: string;
  cost: string;
  recognized_to_date: string;
  cost_account_combination_id: string;
  contra_account_combination_id: string | null;
  expense_account_combination_id: string;
  impairment_account_combination_id: string | null;
  disposal_account_combination_id: string | null;
}>;

async function loadAssetAdjustmentFacts(
  client: PoolClient,
  organizationId: string,
  assetId: string,
  effectiveOn: string,
): Promise<AssetAdjustmentFacts> {
  const result = await client.query<AssetAdjustmentFacts>(
    `SELECT asset.id AS asset_id, asset.asset_number, asset.display_name,
       asset.status, asset.kind, asset.legal_entity_id, asset.ledger_id,
       period.id AS period_id, ledger.functional_currency, asset.cost::text,
       coalesce(sum(schedule.amount) FILTER (WHERE journal.status = 'POSTED'), 0)::text
         AS recognized_to_date,
       category.cost_account_combination_id, category.contra_account_combination_id,
       category.expense_account_combination_id,
       category.impairment_account_combination_id,
       category.disposal_account_combination_id
     FROM asset_register asset
     JOIN asset_categories category
       ON category.organization_id = asset.organization_id AND category.id = asset.category_id
     JOIN ledgers ledger
       ON ledger.organization_id = asset.organization_id AND ledger.id = asset.ledger_id
     JOIN fiscal_periods period
       ON period.organization_id = asset.organization_id AND period.ledger_id = asset.ledger_id
      AND $3::date BETWEEN period.starts_on AND period.ends_on
     LEFT JOIN asset_schedule_entries schedule
       ON schedule.organization_id = asset.organization_id AND schedule.asset_id = asset.id
     LEFT JOIN journal_entries journal
       ON journal.organization_id = schedule.organization_id AND journal.id = schedule.journal_entry_id
     WHERE asset.organization_id = $1 AND asset.id = $2
       AND period.state IN ('OPEN', 'ADJUSTMENT_ONLY')
     GROUP BY asset.id, period.id, ledger.functional_currency,
       category.cost_account_combination_id, category.contra_account_combination_id,
       category.expense_account_combination_id,
       category.impairment_account_combination_id,
       category.disposal_account_combination_id`,
    [organizationId, assetId, effectiveOn],
  );
  const facts = result.rows[0];
  if (!facts) {
    throw new AssetServiceError(
      "The asset was not found or the effective date is not in an eligible open period.",
      409,
      "ASSET_ADJUSTMENT_PERIOD_LOCKED",
    );
  }
  return facts;
}

function adjustmentJournalLines(
  facts: AssetAdjustmentFacts,
  parsed: ReturnType<typeof assetAdjustmentSchema.parse>,
) {
  const currency = facts.functional_currency;
  const line = (accountCombinationId: string, debit: Decimal, credit: Decimal, memo: string) => ({
    accountCombinationId,
    debitFunctional: debit.toFixed(),
    creditFunctional: credit.toFixed(),
    transactionCurrency: currency,
    debitTransaction: debit.toFixed(),
    creditTransaction: credit.toFixed(),
    fxRate: "1",
    fxRateSource: "FUNCTIONAL_CURRENCY",
    fxRateEffectiveAt: `${parsed.effectiveOn}T12:00:00.000Z`,
    memo,
  });
  const zero = new Decimal(0);
  const recognized = quantizeMoney(facts.recognized_to_date, currency);
  const cost = quantizeMoney(facts.cost, currency);
  const creditAssetAccount = facts.kind === "PREPAID"
    ? facts.cost_account_combination_id
    : facts.contra_account_combination_id;
  const impairmentExpense = facts.impairment_account_combination_id ?? facts.expense_account_combination_id;
  const disposalExpense = facts.disposal_account_combination_id ?? impairmentExpense;

  if (parsed.eventType === "TRANSFERRED") return [];
  if (parsed.eventType === "IMPAIRED" || parsed.eventType === "ADJUSTED" || parsed.eventType === "REVERSED") {
    const amount = parsed.amount ? quantizeMoney(parsed.amount, currency) : zero;
    if (!amount.greaterThan(0)) {
      throw new AssetServiceError("This lifecycle event requires a positive adjustment amount.", 400, "ASSET_ADJUSTMENT_AMOUNT_REQUIRED");
    }
    if (!creditAssetAccount) {
      throw new AssetServiceError("The category is missing its accumulated-value account.", 409, "ASSET_CATEGORY_INCOMPLETE");
    }
    if (parsed.eventType === "REVERSED") {
      return [
        line(creditAssetAccount, amount, zero, `${facts.asset_number} adjustment reversal`),
        line(impairmentExpense, zero, amount, `${facts.asset_number} adjustment reversal`),
      ];
    }
    return [
      line(impairmentExpense, amount, zero, `${facts.asset_number} ${parsed.eventType.toLowerCase()}`),
      line(creditAssetAccount, zero, amount, `${facts.asset_number} ${parsed.eventType.toLowerCase()}`),
    ];
  }

  const carrying = facts.kind === "PREPAID" ? cost.minus(recognized) : cost.minus(recognized);
  if (carrying.lessThan(0)) {
    throw new AssetServiceError("Posted recognition exceeds the asset cost.", 409, "ASSET_CARRYING_VALUE_INVALID");
  }
  if (facts.kind === "PREPAID") {
    return carrying.isZero() ? [] : [
      line(disposalExpense, carrying, zero, `${facts.asset_number} remaining balance`),
      line(facts.cost_account_combination_id, zero, carrying, `${facts.asset_number} derecognition`),
    ];
  }
  if (!facts.contra_account_combination_id) {
    throw new AssetServiceError("The category is missing its accumulated-value account.", 409, "ASSET_CATEGORY_INCOMPLETE");
  }
  return [
    ...(recognized.greaterThan(0)
      ? [line(facts.contra_account_combination_id, recognized, zero, `${facts.asset_number} accumulated recognition`)]
      : []),
    ...(carrying.greaterThan(0)
      ? [line(disposalExpense, carrying, zero, `${facts.asset_number} remaining carrying value`)]
      : []),
    line(facts.cost_account_combination_id, zero, cost, `${facts.asset_number} cost derecognition`),
  ];
}

export async function recordAssetAdjustment(input: Readonly<{
  context: TenantTransactionContext;
}> & AssetAdjustmentInput) {
  const { context: _context, ...unparsed } = input;
  void _context;
  const parsed = assetAdjustmentSchema.parse(unparsed);
  const replay = await withAssetWrite({ context: input.context, permission: PERMISSIONS.draftJournal }, async (client) => {
    const replay = await client.query<{ id: string; journal_entry_id: string | null }>(
      `SELECT id, journal_entry_id FROM asset_lifecycle_events
       WHERE organization_id = $1 AND asset_id = $2
         AND details->>'idempotencyKey' = $3`,
      [input.context.organizationId, parsed.assetId, parsed.idempotencyKey],
    );
    return replay.rows[0] ?? null;
  });
  if (replay) return { eventId: replay.id, journalId: replay.journal_entry_id, idempotentReplay: true };

  const facts = await withAssetWrite(
    { context: input.context, permission: PERMISSIONS.draftJournal },
    (client) => loadAssetAdjustmentFacts(
      client,
      input.context.organizationId,
      parsed.assetId,
      parsed.effectiveOn,
    ),
  );
  if (["DISPOSED", "RETIRED", "TERMINATED"].includes(facts.status)) {
    throw new AssetServiceError("A terminal asset cannot receive another lifecycle change.", 409, "ASSET_TERMINAL");
  }
  const lines = adjustmentJournalLines(facts, parsed);
  const journal = lines.length > 0
    ? await createManualJournal({
      context: input.context,
      ledgerId: facts.ledger_id,
      legalEntityId: facts.legal_entity_id,
      periodId: facts.period_id,
      accountingDate: parsed.effectiveOn,
      purpose: "ADJUSTING",
      origin: input.context.sourceSurface === "MCP" ? "MCP" : "API",
      description: `${parsed.eventType.replaceAll("_", " ")} · ${facts.asset_number} · ${facts.display_name}`,
      idempotencyKey: `asset-lifecycle:${parsed.assetId}:${parsed.idempotencyKey}`,
      lines,
    })
    : null;

  return withAssetWrite({ context: input.context, permission: PERMISSIONS.draftJournal }, async (client) => {
    const asset = await client.query<{ status: string }>(
      `SELECT status FROM asset_register WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [input.context.organizationId, parsed.assetId],
    );
    if (!asset.rows[0]) throw new AssetServiceError("The asset record was not found.", 404, "ASSET_NOT_FOUND");
    if (["DISPOSED", "RETIRED", "TERMINATED"].includes(asset.rows[0].status)) {
      throw new AssetServiceError("A terminal asset cannot receive another lifecycle change.", 409, "ASSET_TERMINAL");
    }
    const eventId = randomUUID();
    await client.query(
      `INSERT INTO asset_lifecycle_events(
         id, organization_id, asset_id, event_type, effective_on, amount,
         details, journal_entry_id, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [eventId, input.context.organizationId, parsed.assetId, parsed.eventType,
        parsed.effectiveOn, parsed.amount ?? null,
        JSON.stringify({ reason: parsed.reason, idempotencyKey: parsed.idempotencyKey }),
        journal?.journalId ?? null, input.context.actorId],
    );
    const terminalStatus = ["DISPOSED", "RETIRED", "TERMINATED"].includes(parsed.eventType)
      ? parsed.eventType
      : parsed.eventType === "IMPAIRED" ? "IMPAIRED" : null;
    if (terminalStatus) {
      await client.query(
        `UPDATE asset_register SET status = $3, version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [input.context.organizationId, parsed.assetId, terminalStatus],
      );
      if (terminalStatus !== "IMPAIRED") {
        await client.query(
          `UPDATE asset_schedule_entries SET status = 'SKIPPED', version = version + 1,
             adjustment_reason = $3
           WHERE organization_id = $1 AND asset_id = $2 AND status = 'DUE'`,
          [input.context.organizationId, parsed.assetId, parsed.reason],
        );
      }
    }
    return { eventId, journalId: journal?.journalId ?? null, idempotentReplay: false };
  });
}

function readContext(principal: SessionPrincipal): TenantTransactionContext {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId: `assets-workspace:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "UI",
  };
}

export async function listAssetCategoryVersions(
  principal: SessionPrincipal,
  filter: Readonly<{ categoryKey?: string; ledgerId?: string; code?: string }>,
) {
  return withWorkspaceTenantRead(readContext(principal), "/app/assets", async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.manageOrganizationSettings,
    });
    const result = await client.query(
      `SELECT category.id, category.category_key AS "categoryKey",
         category.legal_entity_id AS "legalEntityId", category.ledger_id AS "ledgerId",
         category.kind, category.code, category.display_name AS "displayName",
         category.cost_account_combination_id AS "costAccountCombinationId",
         category.contra_account_combination_id AS "contraAccountCombinationId",
         category.expense_account_combination_id AS "expenseAccountCombinationId",
         category.impairment_account_combination_id AS "impairmentAccountCombinationId",
         category.disposal_account_combination_id AS "disposalAccountCombinationId",
         category.active, category.version,
         category.supersedes_category_id AS "supersedesCategoryId",
         category.effective_from::text AS "effectiveFrom", category.reason,
         category.created_by AS "createdBy", category.created_at::text AS "createdAt",
         NOT EXISTS (
           SELECT 1 FROM asset_categories successor
           WHERE successor.organization_id=category.organization_id
             AND successor.supersedes_category_id=category.id
         ) AS current,
         (SELECT count(*)::int FROM asset_register asset
          WHERE asset.organization_id=category.organization_id
            AND asset.category_id=category.id) AS "dependentAssetCount",
         (SELECT count(*)::int FROM asset_schedule_entries schedule
          JOIN asset_register asset ON asset.organization_id=schedule.organization_id
            AND asset.id=schedule.asset_id
          WHERE asset.organization_id=category.organization_id
            AND asset.category_id=category.id) AS "dependentScheduleCount"
       FROM asset_categories category
       WHERE category.organization_id=$1
         AND ($2::uuid IS NULL OR category.category_key=$2::uuid)
         AND ($3::uuid IS NULL OR category.ledger_id=$3::uuid)
         AND ($4::text IS NULL OR category.code=$4::text)
       ORDER BY category.category_key, category.version`,
      [principal.organizationId, filter.categoryKey ?? null, filter.ledgerId ?? null,
        filter.code?.trim().toUpperCase() || null],
    );
    return { categories: result.rows };
  });
}

export async function loadAssetWorkspace(principal: SessionPrincipal) {
  return withWorkspaceTenantRead(readContext(principal), "/app/assets", async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readMcpLedger,
    });
    const [canManage, canDraft] = principalCanWrite(principal)
      ? await Promise.all([
        actorHasActivePermission(client, { organizationId: principal.organizationId, actorId: principal.userId, permission: PERMISSIONS.manageOrganizationSettings }),
        actorHasActivePermission(client, { organizationId: principal.organizationId, actorId: principal.userId, permission: PERMISSIONS.draftJournal }),
      ])
      : [false, false];
    const [categories, assets, schedules, accounts, reconciliation] = await Promise.all([
      client.query(`SELECT id, category_key AS "categoryKey", legal_entity_id AS "legalEntityId", ledger_id AS "ledgerId", kind,
          code, display_name AS "displayName", cost_account_combination_id AS "costAccountCombinationId",
          contra_account_combination_id AS "contraAccountCombinationId",
          expense_account_combination_id AS "expenseAccountCombinationId", active, version,
          supersedes_category_id AS "supersedesCategoryId", effective_from::text AS "effectiveFrom",
          reason, created_at::text AS "createdAt",
          NOT EXISTS (SELECT 1 FROM asset_categories successor
            WHERE successor.organization_id=asset_categories.organization_id
              AND successor.supersedes_category_id=asset_categories.id) AS current
        FROM asset_categories WHERE organization_id = $1 ORDER BY kind, code`, [principal.organizationId]),
      client.query(`SELECT asset.id, asset.asset_number AS "assetNumber", asset.display_name AS "displayName",
          asset.kind, asset.classification, asset.status, asset.acquisition_date::text AS "acquisitionDate",
          asset.in_service_on::text AS "inServiceOn", asset.schedule_end_on::text AS "scheduleEndOn",
          asset.cost::text, asset.residual_value::text AS "residualValue",
          coalesce(sum(schedule.amount) FILTER (WHERE journal.status = 'POSTED'), 0)::text AS "recognizedToDate",
          (asset.cost - asset.residual_value - coalesce(sum(schedule.amount) FILTER (WHERE journal.status = 'POSTED'), 0))::text AS "remainingBalance",
          category.code AS "categoryCode", category.display_name AS "categoryName", ledger.functional_currency AS currency
        FROM asset_register asset
        JOIN asset_categories category ON category.organization_id = asset.organization_id AND category.id = asset.category_id
        JOIN ledgers ledger ON ledger.organization_id = asset.organization_id AND ledger.id = asset.ledger_id
        LEFT JOIN asset_schedule_entries schedule ON schedule.organization_id = asset.organization_id AND schedule.asset_id = asset.id
        LEFT JOIN journal_entries journal ON journal.organization_id = schedule.organization_id AND journal.id = schedule.journal_entry_id
        WHERE asset.organization_id = $1
        GROUP BY asset.id, category.code, category.display_name, ledger.functional_currency
        ORDER BY asset.kind, asset.asset_number`, [principal.organizationId]),
      client.query(`SELECT schedule.id, schedule.asset_id AS "assetId", schedule.sequence_number AS "sequenceNumber",
          schedule.period_start_on::text AS "periodStartOn", schedule.period_end_on::text AS "periodEndOn",
          schedule.due_on::text AS "dueOn", schedule.amount::text,
          CASE WHEN journal.status = 'POSTED' THEN 'POSTED' ELSE schedule.status END AS status,
          schedule.journal_entry_id AS "journalEntryId", asset.asset_number AS "assetNumber"
        FROM asset_schedule_entries schedule
        JOIN asset_register asset ON asset.organization_id = schedule.organization_id AND asset.id = schedule.asset_id
        LEFT JOIN journal_entries journal ON journal.organization_id = schedule.organization_id AND journal.id = schedule.journal_entry_id
        WHERE schedule.organization_id = $1
        ORDER BY schedule.due_on, asset.asset_number, schedule.sequence_number
        LIMIT 500`, [principal.organizationId]),
      client.query(`SELECT combination.id, combination.entity_id AS "legalEntityId", combination.ledger_id AS "ledgerId",
          entity.code AS "entityCode", ledger.code AS "ledgerCode",
          account.code, account.display_name AS "displayName", account.class::text AS class
        FROM account_combinations combination
        JOIN gl_accounts account ON account.organization_id = combination.organization_id
          AND account.ledger_id = combination.ledger_id AND account.id = combination.account_id
        JOIN legal_entities entity ON entity.organization_id = combination.organization_id
          AND entity.id = combination.entity_id
        JOIN ledgers ledger ON ledger.organization_id = combination.organization_id
          AND ledger.id = combination.ledger_id
        WHERE combination.organization_id = $1 AND combination.active AND account.active AND account.postable
          AND account.control_kind = 'NONE'
        ORDER BY account.code`, [principal.organizationId]),
      client.query<{
        categoryId: string;
        categoryCode: string;
        categoryName: string;
        currency: string;
        grossCost: string;
        recognized: string;
        costGlBalance: string;
        contraGlBalance: string;
      }>(`SELECT category.id AS "categoryId", category.code AS "categoryCode",
          category.display_name AS "categoryName", ledger.functional_currency AS currency,
          coalesce((SELECT sum(asset.cost) FROM asset_register asset
            WHERE asset.organization_id = category.organization_id
              AND asset.category_id = category.id), 0)::text AS "grossCost",
          coalesce((SELECT sum(schedule.amount)
            FROM asset_schedule_entries schedule
            JOIN asset_register asset ON asset.organization_id = schedule.organization_id
              AND asset.id = schedule.asset_id
            JOIN journal_entries journal ON journal.organization_id = schedule.organization_id
              AND journal.id = schedule.journal_entry_id AND journal.status = 'POSTED'
            WHERE schedule.organization_id = category.organization_id
              AND asset.category_id = category.id), 0)::text AS recognized,
          coalesce((SELECT sum(line.debit_functional - line.credit_functional)
            FROM journal_lines line
            JOIN journal_entries journal ON journal.organization_id = line.organization_id
              AND journal.id = line.journal_entry_id AND journal.status = 'POSTED'
            WHERE line.organization_id = category.organization_id
              AND line.account_combination_id = category.cost_account_combination_id), 0)::text
            AS "costGlBalance",
          coalesce((SELECT sum(line.credit_functional - line.debit_functional)
            FROM journal_lines line
            JOIN journal_entries journal ON journal.organization_id = line.organization_id
              AND journal.id = line.journal_entry_id AND journal.status = 'POSTED'
            WHERE line.organization_id = category.organization_id
              AND line.account_combination_id = category.contra_account_combination_id), 0)::text
            AS "contraGlBalance"
        FROM asset_categories category
        JOIN ledgers ledger ON ledger.organization_id = category.organization_id
          AND ledger.id = category.ledger_id
        WHERE category.organization_id = $1
        ORDER BY category.kind, category.code`, [principal.organizationId]),
    ]);
    const reconciliationRows = reconciliation.rows.map((row) => {
      const registerNet = new Decimal(row.grossCost).minus(row.recognized);
      const glNet = new Decimal(row.costGlBalance).minus(row.contraGlBalance);
      return {
        ...row,
        registerNet: registerNet.toFixed(),
        glNet: glNet.toFixed(),
        variance: glNet.minus(registerNet).toFixed(),
      };
    });
    return {
      categories: categories.rows,
      assets: assets.rows,
      schedules: schedules.rows,
      accounts: accounts.rows,
      reconciliation: reconciliationRows,
      canManageCategories: canManage,
      canDraftSchedules: canDraft,
      isDemo: principal.sessionMode === "demo",
    };
  });
}

export function assetMutationContext(principal: SessionPrincipal, requestId: string, reason: string): TenantTransactionContext {
  return mutationContext(principal, requestId, { reason, sourceSurface: "API" });
}
