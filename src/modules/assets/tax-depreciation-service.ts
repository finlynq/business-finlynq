import "server-only";

import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS, type Permission } from "@/modules/identity/permissions";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";
import { AssetServiceError } from "./service";
import {
  CANADIAN_CCA_RULES,
  calculateCcaSchedule,
  ccaScheduleInputSchema,
  effectiveCcaRule,
} from "./tax-depreciation";

const money = z.string().trim().regex(/^\d+(?:\.\d{1,9})?$/);
const positiveMoney = money.refine((value) => new Decimal(value).greaterThan(0));
const reason = z.string().trim().min(8).max(500);
const idempotencyKey = z.string().trim().min(1).max(180);

export const proposeAssetTaxClassificationSchema = z.object({
  assetId: z.uuid(),
  propertyKind: z.enum(["COMPUTER_HARDWARE", "OTHER"]),
  availableForUseOn: z.iso.date(),
}).strict();

export const saveAssetTaxClassificationSchema = z.object({
  assetId: z.uuid(),
  expectedVersion: z.number().int().min(0),
  ruleKey: z.string().trim().min(1).max(100),
  poolKey: z.string().trim().min(1).max(100),
  availableForUseOn: z.iso.date(),
  businessUsePercent: z.string().trim().regex(/^\d+(?:\.\d{1,4})?$/).refine((value) => new Decimal(value).greaterThan(0) && new Decimal(value).lessThanOrEqualTo(100)),
  costBeforeSalesTax: positiveMoney,
  recoverableSalesTax: money.default("0"),
  nonRecoverableSalesTax: money.default("0"),
  assistance: money.default("0"),
  eligibilityEvidence: z.string().trim().min(8).max(1_000),
  elections: z.array(z.object({
    key: z.string().trim().min(1).max(100),
    madeOn: z.iso.date(),
    evidence: z.string().trim().min(1).max(500),
  }).strict()).max(20).default([]),
  reason,
  idempotencyKey,
}).strict();

export const createAssetTaxScheduleSchema = z.object({
  classificationId: z.uuid(),
  expectedScheduleVersion: z.number().int().min(0),
  openingUcc: money.default("0"),
  years: ccaScheduleInputSchema.shape.years,
  idempotencyKey,
}).strict();

export const attachAssetTaxAdjustmentSchema = z.object({
  filingId: z.uuid(),
  assetTaxScheduleId: z.uuid(),
  reason,
  idempotencyKey,
}).strict();

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function withAssetTaxWrite<T>(input: Readonly<{
  context: TenantTransactionContext;
  permission: Permission;
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

async function assetFacts(client: PoolClient, organizationId: string, assetId: string) {
  const row = (await client.query<{
    id: string; kind: string; display_name: string; acquisition_date: string;
    in_service_on: string; cost: string; legal_entity_id: string; ledger_id: string;
  }>(
    `SELECT id, kind, display_name, acquisition_date::text, in_service_on::text,
       cost::text, legal_entity_id, ledger_id
     FROM asset_register WHERE organization_id=$1 AND id=$2`,
    [organizationId, assetId],
  )).rows[0];
  if (!row) throw new AssetServiceError("The asset record was not found.", 404, "ASSET_NOT_FOUND");
  return row;
}

export async function proposeAssetTaxClassification(input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof proposeAssetTaxClassificationSchema>) {
  const { context, ...raw } = input;
  const command = proposeAssetTaxClassificationSchema.parse(raw);
  return withTenantTransaction(context, async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: context.organizationId,
      actorId: context.actorId,
      permission: PERMISSIONS.readTax,
    });
    const asset = await assetFacts(client, context.organizationId, command.assetId);
    if (command.propertyKind !== "COMPUTER_HARDWARE") {
      return { asset, candidates: [], instruction: "No class was inferred. Supply reviewed property facts and a cited effective-dated rule." };
    }
    const candidates = CANADIAN_CCA_RULES.filter((rule) => rule.classKey === "50" &&
      rule.effectiveFrom <= command.availableForUseOn &&
      (rule.effectiveTo === null || rule.effectiveTo >= command.availableForUseOn));
    return {
      asset,
      candidates: candidates.map((rule) => ({ ...rule, confidence: "REVIEW_REQUIRED" })),
      instruction: "Review the property facts and legal citation. The candidate is not saved and book useful life was not used.",
    };
  });
}

export async function saveAssetTaxClassification(input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof saveAssetTaxClassificationSchema>) {
  const { context, ...raw } = input;
  const command = saveAssetTaxClassificationSchema.parse(raw);
  const rule = effectiveCcaRule(command.ruleKey, command.availableForUseOn);
  const taxCapitalCost = new Decimal(command.costBeforeSalesTax).plus(command.nonRecoverableSalesTax).toFixed(9);
  if (new Decimal(command.assistance).greaterThan(taxCapitalCost)) {
    throw new AssetServiceError("Assistance cannot exceed the reviewed tax capital cost.", 400, "CCA_ASSISTANCE_INVALID");
  }
  const commandHash = hash({ ...command, taxCapitalCost, idempotencyKey: undefined, rule });
  return withAssetTaxWrite({ context, permission: PERMISSIONS.manageTaxMappings }, async (client) => {
    const replay = (await client.query<{ id: string; version: number; command_hash: string }>(
      `SELECT id, version, command_hash FROM asset_tax_classifications WHERE organization_id=$1 AND idempotency_key=$2`,
      [context.organizationId, command.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new AssetServiceError("The classification idempotency key was used for different facts.", 409, "CCA_IDEMPOTENCY_CONFLICT");
      return { classificationId: replay.id, version: replay.version, idempotentReplay: true };
    }
    const asset = await assetFacts(client, context.organizationId, command.assetId);
    if (asset.kind !== "TANGIBLE") throw new AssetServiceError("CCA classification currently supports tangible assets only.", 400, "CCA_ASSET_KIND_UNSUPPORTED");
    if (command.availableForUseOn < asset.acquisition_date) throw new AssetServiceError("Available-for-use date cannot precede acquisition.", 400, "CCA_AVAILABLE_DATE_INVALID");
    if (rule.firstYearTreatment === "IMMEDIATE_EXPENSING" && asset.acquisition_date < rule.effectiveFrom) {
      throw new AssetServiceError("The selected immediate-expensing rule requires both acquisition and available-for-use dates in its enacted window.", 400, "CCA_INCENTIVE_DATE_INVALID");
    }
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:asset-tax-classification:' || $1::text || ':' || $2::text, 0))",
      [context.organizationId, command.assetId],
    );
    const current = (await client.query<{ id: string; version: number }>(
      `SELECT classification.id, classification.version
       FROM asset_tax_classifications classification
       WHERE classification.organization_id=$1 AND classification.asset_id=$2
         AND NOT EXISTS (SELECT 1 FROM asset_tax_classifications successor
           WHERE successor.organization_id=classification.organization_id
             AND successor.supersedes_classification_id=classification.id)
       ORDER BY classification.version DESC LIMIT 1`,
      [context.organizationId, command.assetId],
    )).rows[0];
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== command.expectedVersion) throw new AssetServiceError("The tax classification version is stale.", 409, "CCA_CLASSIFICATION_VERSION_CONFLICT");
    const classificationId = randomUUID();
    const version = currentVersion + 1;
    await client.query(
      `INSERT INTO asset_tax_classifications(
         id, organization_id, asset_id, jurisdiction, regime_key, class_key,
         pool_key, prescribed_rate, available_for_use_on, business_use_percent,
         cost_before_sales_tax, recoverable_sales_tax, non_recoverable_sales_tax,
         tax_capital_cost, assistance, rule_key, rule_version, authority_status,
         source_uri, eligibility_evidence, elections, version,
         supersedes_classification_id, reason, idempotency_key, command_hash, created_by
       ) VALUES ($1,$2,$3,'CA','CANADA_CCA',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,$24,$25)`,
      [classificationId, context.organizationId, command.assetId, rule.classKey,
        command.poolKey, rule.prescribedRate, command.availableForUseOn,
        command.businessUsePercent, command.costBeforeSalesTax,
        command.recoverableSalesTax, command.nonRecoverableSalesTax,
        taxCapitalCost, command.assistance,
        rule.key, rule.version, rule.authorityStatus, rule.sourceUri,
        command.eligibilityEvidence, JSON.stringify(command.elections), version,
        current?.id ?? null, command.reason, command.idempotencyKey, commandHash, context.actorId],
    );
    return { classificationId, version, rule, idempotentReplay: false };
  });
}

async function classificationFacts(client: PoolClient, organizationId: string, classificationId: string) {
  const row = (await client.query<{
    id: string; asset_id: string; prescribed_rate: string; business_use_percent: string;
    available_for_use_on: string; rule_key: string; rule_version: string;
    authority_status: "ENACTED" | "PROPOSED"; source_uri: string;
    tax_capital_cost: string; assistance: string;
  }>(
    `SELECT id, asset_id, prescribed_rate::text, business_use_percent::text,
       available_for_use_on::text, rule_key, rule_version, authority_status, source_uri,
       tax_capital_cost::text, assistance::text
     FROM asset_tax_classifications classification
     WHERE organization_id=$1 AND id=$2
       AND NOT EXISTS (SELECT 1 FROM asset_tax_classifications successor
         WHERE successor.organization_id=classification.organization_id
           AND successor.supersedes_classification_id=classification.id)`,
    [organizationId, classificationId],
  )).rows[0];
  if (!row) throw new AssetServiceError("Choose the current reviewed tax classification.", 404, "CCA_CLASSIFICATION_NOT_FOUND");
  return row;
}

async function calculateSchedule(client: PoolClient, organizationId: string, command: z.output<typeof createAssetTaxScheduleSchema>) {
  const classification = await classificationFacts(client, organizationId, command.classificationId);
  if (classification.authority_status !== "ENACTED") throw new AssetServiceError("A proposed rule cannot support a claimed CCA schedule.", 409, "CCA_RULE_NOT_ENACTED");
  const rule = effectiveCcaRule(classification.rule_key, classification.available_for_use_on);
  const first = command.years[0]!;
  if (first.taxYear !== Number(classification.available_for_use_on.slice(0, 4)) ||
      !new Decimal(first.additions).equals(classification.tax_capital_cost) ||
      !new Decimal(first.assistance).equals(classification.assistance) ||
      command.expectedScheduleVersion === 0 && !new Decimal(command.openingUcc).isZero()) {
    throw new AssetServiceError("A CCA schedule must begin in the available-for-use year with zero initial UCC and the exact reviewed capital cost and assistance.", 400, "CCA_INITIAL_CONTINUITY_INVALID");
  }
  if (command.years.slice(1).some((year) => !new Decimal(year.additions).isZero() || !new Decimal(year.assistance).isZero())) {
    throw new AssetServiceError("Later capital additions require a new reviewed classification version and effective-dated first-year rule.", 400, "CCA_ADDITION_REVIEW_REQUIRED");
  }
  const lines = calculateCcaSchedule({
    openingUcc: command.openingUcc,
    prescribedRate: classification.prescribed_rate,
    firstYearFactor: rule.firstYearFactor,
    businessUsePercent: classification.business_use_percent,
    years: command.years,
  });
  return { classification, rule, lines };
}

export async function previewAssetTaxSchedule(input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof createAssetTaxScheduleSchema>) {
  const { context, ...raw } = input;
  const command = createAssetTaxScheduleSchema.parse(raw);
  return withTenantTransaction(context, async (client) => ({
    ...await calculateSchedule(client, context.organizationId, command),
    writesPerformed: false,
  }));
}

export async function createAssetTaxSchedule(input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof createAssetTaxScheduleSchema>) {
  const { context, ...raw } = input;
  const command = createAssetTaxScheduleSchema.parse(raw);
  const commandHash = hash({ ...command, idempotencyKey: undefined });
  return withAssetTaxWrite({ context, permission: PERMISSIONS.manageTaxMappings }, async (client) => {
    const replay = (await client.query<{ id: string; version: number; command_hash: string }>(
      `SELECT id, version, command_hash FROM asset_tax_schedules WHERE organization_id=$1 AND idempotency_key=$2`,
      [context.organizationId, command.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new AssetServiceError("The CCA schedule idempotency key was used for different facts.", 409, "CCA_IDEMPOTENCY_CONFLICT");
      return { scheduleId: replay.id, version: replay.version, idempotentReplay: true };
    }
    const calculated = await calculateSchedule(client, context.organizationId, command);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:asset-tax-schedule:' || $1::text || ':' || $2::text || ':' || $3::text || ':' || $4::text, 0))",
      [context.organizationId, command.classificationId, command.years[0]!.taxYear, command.years.at(-1)!.taxYear],
    );
    const current = (await client.query<{ id: string; version: number; schedule_snapshot: unknown }>(
      `SELECT schedule.id, schedule.version, schedule.schedule_snapshot FROM asset_tax_schedules schedule
       WHERE schedule.organization_id=$1 AND schedule.classification_id=$2
         AND schedule.tax_year_start=$3 AND schedule.tax_year_end=$4
         AND NOT EXISTS (SELECT 1 FROM asset_tax_schedules successor
           WHERE successor.organization_id=schedule.organization_id AND successor.supersedes_schedule_id=schedule.id)
       ORDER BY schedule.version DESC LIMIT 1`,
      [context.organizationId, command.classificationId, command.years[0]!.taxYear, command.years.at(-1)!.taxYear],
    )).rows[0];
    if ((current?.version ?? 0) !== command.expectedScheduleVersion) throw new AssetServiceError("The CCA schedule version is stale.", 409, "CCA_SCHEDULE_VERSION_CONFLICT");
    if (current) {
      const firstCurrentLine = Array.isArray(current.schedule_snapshot) ? current.schedule_snapshot[0] : null;
      const previousOpening = firstCurrentLine && typeof firstCurrentLine === "object"
        ? (firstCurrentLine as { openingUcc?: unknown }).openingUcc
        : undefined;
      if (typeof previousOpening !== "string" || !new Decimal(previousOpening).equals(command.openingUcc)) {
        throw new AssetServiceError("A recalculated CCA schedule must preserve the reviewed opening UCC.", 409, "CCA_OPENING_CONTINUITY_INVALID");
      }
    }
    const scheduleId = randomUUID();
    const version = (current?.version ?? 0) + 1;
    const maximumCca = calculated.lines.reduce((sum, line) => sum.plus(line.maximumCca), new Decimal(0));
    const claimedCca = calculated.lines.reduce((sum, line) => sum.plus(line.claimedCca), new Decimal(0));
    await client.query(
      `INSERT INTO asset_tax_schedules(
         id, organization_id, asset_id, classification_id, tax_year_start,
         tax_year_end, schedule_snapshot, maximum_cca, claimed_cca, closing_ucc,
         version, supersedes_schedule_id, idempotency_key, command_hash, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [scheduleId, context.organizationId, calculated.classification.asset_id,
        command.classificationId, command.years[0]!.taxYear, command.years.at(-1)!.taxYear,
        JSON.stringify(calculated.lines), maximumCca.toFixed(2), claimedCca.toFixed(2),
        calculated.lines.at(-1)!.closingUcc, version, current?.id ?? null,
        command.idempotencyKey, commandHash, context.actorId],
    );
    return { scheduleId, version, maximumCca: maximumCca.toFixed(2), claimedCca: claimedCca.toFixed(2), closingUcc: calculated.lines.at(-1)!.closingUcc, idempotentReplay: false };
  });
}

export async function loadAssetTaxWorkspace(context: TenantTransactionContext) {
  return withTenantTransaction(context, async (client) => {
    await assertActorHasActivePermission(client, { organizationId: context.organizationId, actorId: context.actorId, permission: PERMISSIONS.readTax });
    const [assets, classifications, schedules, adjustments] = await Promise.all([
      client.query(`SELECT asset.id, asset.asset_number AS "assetNumber", asset.display_name AS "displayName",
          asset.kind, asset.cost::text, asset.in_service_on::text AS "inServiceOn",
          NOT EXISTS (SELECT 1 FROM asset_tax_classifications classification WHERE classification.organization_id=asset.organization_id AND classification.asset_id=asset.id) AS "needsClassification"
        FROM asset_register asset WHERE asset.organization_id=$1 ORDER BY asset.asset_number`, [context.organizationId]),
      client.query(`SELECT classification.id, classification.asset_id AS "assetId", classification.jurisdiction,
          classification.regime_key AS "regimeKey", classification.class_key AS "classKey", classification.pool_key AS "poolKey",
          classification.prescribed_rate::text AS "prescribedRate", classification.available_for_use_on::text AS "availableForUseOn",
          classification.business_use_percent::text AS "businessUsePercent", classification.tax_capital_cost::text AS "taxCapitalCost",
          classification.cost_before_sales_tax::text AS "costBeforeSalesTax", classification.recoverable_sales_tax::text AS "recoverableSalesTax",
          classification.non_recoverable_sales_tax::text AS "nonRecoverableSalesTax", classification.assistance::text,
          classification.rule_key AS "ruleKey", classification.rule_version AS "ruleVersion",
          classification.authority_status AS "authorityStatus", classification.source_uri AS "sourceUri", classification.version,
          classification.eligibility_evidence AS "eligibilityEvidence", classification.elections,
          NOT EXISTS (SELECT 1 FROM asset_tax_classifications successor WHERE successor.organization_id=classification.organization_id AND successor.supersedes_classification_id=classification.id) AS current
        FROM asset_tax_classifications classification WHERE classification.organization_id=$1 ORDER BY classification.asset_id, classification.version`, [context.organizationId]),
      client.query(`SELECT schedule.id, schedule.asset_id AS "assetId", schedule.classification_id AS "classificationId",
          schedule.tax_year_start AS "taxYearStart", schedule.tax_year_end AS "taxYearEnd", schedule.schedule_snapshot AS lines,
          schedule.maximum_cca::text AS "maximumCca", schedule.claimed_cca::text AS "claimedCca", schedule.closing_ucc::text AS "closingUcc", schedule.version,
          NOT EXISTS (SELECT 1 FROM asset_tax_schedules successor WHERE successor.organization_id=schedule.organization_id AND successor.supersedes_schedule_id=schedule.id) AS current
        FROM asset_tax_schedules schedule WHERE schedule.organization_id=$1 ORDER BY schedule.asset_id, schedule.tax_year_start, schedule.version`, [context.organizationId]),
      client.query(`SELECT adjustment.id, adjustment.filing_id AS "filingId", adjustment.asset_tax_schedule_id AS "assetTaxScheduleId",
          adjustment.adjustment_snapshot AS snapshot, adjustment.reason, adjustment.created_at::text AS "createdAt"
        FROM tax_filing_asset_adjustments adjustment WHERE adjustment.organization_id=$1 ORDER BY adjustment.created_at, adjustment.id`, [context.organizationId]),
    ]);
    return { rules: CANADIAN_CCA_RULES, assets: assets.rows, classifications: classifications.rows, schedules: schedules.rows, adjustments: adjustments.rows };
  });
}

export async function attachAssetTaxAdjustment(input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof attachAssetTaxAdjustmentSchema>) {
  const { context, ...raw } = input;
  const command = attachAssetTaxAdjustmentSchema.parse(raw);
  const commandHash = hash({ ...command, idempotencyKey: undefined });
  return withAssetTaxWrite({ context, permission: PERMISSIONS.prepareTaxFilings }, async (client) => {
    const replay = (await client.query<{ id: string; command_hash: string }>(
      `SELECT id, command_hash FROM tax_filing_asset_adjustments WHERE organization_id=$1 AND idempotency_key=$2`,
      [context.organizationId, command.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new AssetServiceError("The workpaper adjustment idempotency key was used for different facts.", 409, "CCA_IDEMPOTENCY_CONFLICT");
      return { adjustmentId: replay.id, idempotentReplay: true };
    }
    const existing = (await client.query(
      `SELECT 1 FROM tax_filing_asset_adjustments
       WHERE organization_id=$1 AND filing_id=$2 AND asset_tax_schedule_id=$3`,
      [context.organizationId, command.filingId, command.assetTaxScheduleId],
    )).rows[0];
    if (existing) throw new AssetServiceError("This exact CCA schedule is already attached to the filing workpaper.", 409, "CCA_WORKPAPER_ADJUSTMENT_EXISTS");
    const row = (await client.query<{
      filing_id: string; mapping_set_id: string; period_start: string; period_end: string;
      schedule_id: string; asset_id: string; schedule_snapshot: unknown; claimed_cca: string;
      maximum_cca: string; rule_key: string; rule_version: string; source_uri: string;
    }>(
      `SELECT filing.id AS filing_id, filing.mapping_set_id, filing.period_start::text, filing.period_end::text,
         schedule.id AS schedule_id, schedule.asset_id, schedule.schedule_snapshot,
         schedule.claimed_cca::text, schedule.maximum_cca::text,
         classification.rule_key, classification.rule_version, classification.source_uri
       FROM tax_filings filing
       JOIN asset_tax_schedules schedule ON schedule.organization_id=filing.organization_id AND schedule.id=$3
       JOIN asset_tax_classifications classification ON classification.organization_id=schedule.organization_id AND classification.id=schedule.classification_id
       WHERE filing.organization_id=$1 AND filing.id=$2
         AND extract(year FROM filing.period_end)::int BETWEEN schedule.tax_year_start AND schedule.tax_year_end
         AND NOT EXISTS (SELECT 1 FROM asset_tax_schedules successor
           WHERE successor.organization_id=schedule.organization_id
             AND successor.supersedes_schedule_id=schedule.id)`,
      [context.organizationId, command.filingId, command.assetTaxScheduleId],
    )).rows[0];
    if (!row) throw new AssetServiceError("The filing workpaper or CCA schedule was not found.", 404, "CCA_WORKPAPER_TARGET_NOT_FOUND");
    const yearStart = Number(row.period_start.slice(0, 4));
    const yearEnd = Number(row.period_end.slice(0, 4));
    const book = (await client.query<{ amount: string }>(
      `SELECT coalesce(sum(schedule.amount),0)::text AS amount FROM asset_schedule_entries schedule
       WHERE schedule.organization_id=$1 AND schedule.asset_id=$2
         AND extract(year FROM schedule.due_on)::int BETWEEN $3 AND $4`,
      [context.organizationId, row.asset_id, yearStart, yearEnd],
    )).rows[0]?.amount ?? "0";
    const snapshot = {
      filingId: row.filing_id,
      mappingSetId: row.mapping_set_id,
      assetId: row.asset_id,
      assetTaxScheduleId: row.schedule_id,
      bookDepreciation: new Decimal(book).toFixed(2),
      maximumCca: new Decimal(row.maximum_cca).toFixed(2),
      claimedCca: new Decimal(row.claimed_cca).toFixed(2),
      bookToTaxDifference: new Decimal(book).minus(row.claimed_cca).toFixed(2),
      rule: { key: row.rule_key, version: row.rule_version, sourceUri: row.source_uri },
      schedule: row.schedule_snapshot,
    };
    const adjustmentId = randomUUID();
    await client.query(
      `INSERT INTO tax_filing_asset_adjustments(
         id, organization_id, filing_id, asset_tax_schedule_id, adjustment_snapshot,
         reason, idempotency_key, command_hash, created_by
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
      [adjustmentId, context.organizationId, command.filingId, command.assetTaxScheduleId,
        JSON.stringify(snapshot), command.reason, command.idempotencyKey, commandHash, context.actorId],
    );
    return { adjustmentId, snapshot, idempotentReplay: false };
  });
}
