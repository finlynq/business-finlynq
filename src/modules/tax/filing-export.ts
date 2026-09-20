import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { transactionAuthMethod, type SessionPrincipal } from "@/modules/identity/session";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";

export const taxFilingExportSchema = z.object({
  filingId: z.uuid(),
  format: z.enum(["JSON", "CSV"]).default("JSON"),
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const taxFilingExportPreviewSchema = z.object({ filingId: z.uuid() }).strict();
export const taxFilingWorkpaperListSchema = z.object({
  legalEntityId: z.uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

const MAX_MAPPING_ROWS = 1_000;
const MAX_DETERMINATION_ROWS = 5_000;
const MAX_ADJUSTMENT_ROWS = 1_000;
const MAX_REFERENCE_ROWS = 5_000;
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

function context(principal: SessionPrincipal) {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId: `tax-export:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "MCP" as const,
  };
}

function csvCell(value: unknown): string {
  const text = typeof value === "string" ? value : canonical(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function packageCsv(payload: Record<string, unknown>): string {
  const rows: string[][] = [["section", "key", "value"]];
  for (const [section, value] of Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
        rows.push([section, key, typeof entry === "string" ? entry : canonical(entry)]);
      }
    } else {
      rows.push([section, "", typeof value === "string" ? value : canonical(value)]);
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

async function buildPackage(principal: SessionPrincipal, filingId: string) {
  return withWorkspaceTenantRead(context(principal), "/app/tax", async (client) => {
    await assertActorHasActivePermission(client, { organizationId: principal.organizationId, actorId: principal.userId, permission: PERMISSIONS.readTax });
    const filing = (await client.query<Record<string, unknown>>(
      `SELECT filing.id, filing.filing_type AS "filingType", filing.status,
         filing.period_start::text AS "periodStart", filing.period_end::text AS "periodEnd",
         filing.external_reference AS "externalReference", filing.source_file_name AS "sourceFileName",
         filing.reported_values AS "reportedValues", filing.calculated_values AS "calculatedValues",
         filing.reconciliation_snapshot AS reconciliation, filing.validation_snapshot AS validations,
         filing.template_snapshot AS template, filing.mapping_set_id AS "mappingSetId",
         filing.created_by AS "preparedBy", filing.created_at::text AS "preparedAt",
         entity.id AS "legalEntityId", entity.code AS "entityCode", entity.display_name AS "entityName",
         ledger.id AS "ledgerId", ledger.code AS "ledgerCode", ledger.functional_currency AS currency
       FROM tax_filings filing
       JOIN legal_entities entity ON entity.organization_id=filing.organization_id AND entity.id=filing.legal_entity_id
       JOIN ledgers ledger ON ledger.organization_id=filing.organization_id AND ledger.id=filing.ledger_id
       WHERE filing.organization_id=$1 AND filing.id=$2`,
      [principal.organizationId, filingId],
    )).rows[0];
    if (!filing) throw Object.assign(new Error("The immutable filing workpaper was not found."), { code: "TAX_WORKPAPER_NOT_FOUND" });
    const [registrations, mappings, determinations, adjustments, references] = await Promise.all([
      client.query(
        `SELECT registration.id, registration.regime_key AS "regimeKey",
           registration.destination_country AS "destinationCountry",
           registration.destination_region AS "destinationRegion",
           registration.destination_city AS "destinationCity",
           registration.location_code AS "locationCode",
           registration.valid_from::text AS "validFrom", registration.valid_to::text AS "validTo"
         FROM entity_tax_registrations registration
         WHERE registration.organization_id=$1 AND registration.legal_entity_id=$2
           AND registration.valid_from <= $4::date
           AND (registration.valid_to IS NULL OR registration.valid_to >= $3::date)
         ORDER BY registration.regime_key, registration.valid_from, registration.id
         LIMIT 101`,
        [principal.organizationId, filing.legalEntityId, filing.periodStart, filing.periodEnd],
      ),
      client.query(
        `WITH mapped_balances AS (
           SELECT mapping.id, mapping.field_key, mapping.gl_account_id,
             mapping.balance_basis, mapping.multiplier,
             account.code AS account_code, account.display_name AS account_name,
             coalesce(sum(journal_line.debit_functional) FILTER (WHERE journal.id IS NOT NULL), 0) AS debits,
             coalesce(sum(journal_line.credit_functional) FILTER (WHERE journal.id IS NOT NULL), 0) AS credits
           FROM tax_account_mapping_lines mapping
           JOIN tax_account_mapping_sets mapping_set
             ON mapping_set.organization_id=mapping.organization_id AND mapping_set.id=mapping.mapping_set_id
           JOIN gl_accounts account
             ON account.organization_id=mapping.organization_id AND account.id=mapping.gl_account_id
           LEFT JOIN account_combinations combination
             ON combination.organization_id=mapping.organization_id
            AND combination.ledger_id=mapping_set.ledger_id
            AND combination.account_id=mapping.gl_account_id
           LEFT JOIN journal_lines journal_line
             ON journal_line.organization_id=mapping.organization_id
            AND journal_line.ledger_id=mapping_set.ledger_id
            AND journal_line.account_combination_id=combination.id
           LEFT JOIN journal_entries journal
             ON journal.organization_id=journal_line.organization_id
            AND journal.id=journal_line.journal_entry_id
            AND journal.status='POSTED'
            AND journal.accounting_date BETWEEN $3::date AND $4::date
           WHERE mapping.organization_id=$1 AND mapping.mapping_set_id=$2
           GROUP BY mapping.id, mapping.field_key, mapping.gl_account_id,
             mapping.balance_basis, mapping.multiplier, account.code, account.display_name
         )
         SELECT id AS "mappingLineId", field_key AS "fieldKey", gl_account_id AS "glAccountId",
           account_code AS "accountCode", account_name AS "accountName",
           balance_basis AS "balanceBasis", multiplier::text AS multiplier,
           debits::text, credits::text,
           ((CASE balance_basis
             WHEN 'DEBITS' THEN debits WHEN 'CREDITS' THEN credits
             WHEN 'NET_DEBIT' THEN debits-credits WHEN 'NET_CREDIT' THEN credits-debits
             WHEN 'ABSOLUTE_NET' THEN abs(debits-credits)
           END) * multiplier)::text AS "mappedBalance"
         FROM mapped_balances
         ORDER BY field_key, account_code, id
         LIMIT ${MAX_MAPPING_ROWS + 1}`,
        [principal.organizationId, filing.mappingSetId, filing.periodStart, filing.periodEnd],
      ),
      client.query(
        `SELECT determination.id, determination.status, determination.rule_key AS "ruleKey",
           determination.jurisdiction, determination.currency,
           determination.taxable_basis::text AS "taxableBasis", determination.total_tax::text AS "totalTax",
           determination.source_document_id AS "sourceDocumentId", determination.decision_hash AS "decisionHash",
           determination.created_at::text AS "createdAt",
           jsonb_agg(DISTINCT jsonb_build_object(
             'journalEntryId', journal.id,
             'journalNumber', journal.journal_number,
             'accountingDate', journal.accounting_date,
             'contentHash', journal.content_hash,
             'sourceDocumentId', journal.source_document_id
           )) AS "journalReferences"
         FROM tax_determination_snapshots determination
         JOIN journal_lines journal_line
           ON journal_line.organization_id=determination.organization_id
          AND journal_line.tax_snapshot_id=determination.id
         JOIN journal_entries journal
           ON journal.organization_id=journal_line.organization_id
          AND journal.id=journal_line.journal_entry_id
          AND journal.status='POSTED'
         WHERE determination.organization_id=$1 AND determination.ledger_id=$2
           AND journal.accounting_date BETWEEN $3::date AND $4::date
         GROUP BY determination.id, determination.status, determination.rule_key,
           determination.jurisdiction, determination.currency, determination.taxable_basis,
           determination.total_tax, determination.source_document_id,
           determination.decision_hash, determination.created_at
         ORDER BY determination.created_at, determination.id
         LIMIT ${MAX_DETERMINATION_ROWS + 1}`,
        [principal.organizationId, filing.ledgerId, filing.periodStart, filing.periodEnd],
      ),
      client.query(
        `SELECT adjustment.id, adjustment.asset_tax_schedule_id AS "assetTaxScheduleId",
           adjustment.adjustment_snapshot AS snapshot, adjustment.reason,
           adjustment.created_by AS "reviewedBy", adjustment.created_at::text AS "reviewedAt"
         FROM tax_filing_asset_adjustments adjustment
         WHERE adjustment.organization_id=$1 AND adjustment.filing_id=$2
         ORDER BY adjustment.created_at, adjustment.id
         LIMIT ${MAX_ADJUSTMENT_ROWS + 1}`,
        [principal.organizationId, filingId],
      ),
      client.query(
        `SELECT DISTINCT journal.id AS "journalEntryId", journal.journal_number AS "journalNumber",
           journal.accounting_date::text AS "accountingDate", journal.status,
           journal.content_hash AS "contentHash", journal.source_document_id AS "sourceDocumentId",
           source.source_type AS "sourceType", source.source_number AS "sourceNumber",
           source.version AS "sourceVersion", source.content_hash AS "sourceContentHash"
         FROM journal_entries journal
         JOIN journal_lines journal_line
           ON journal_line.organization_id=journal.organization_id
          AND journal_line.journal_entry_id=journal.id
         LEFT JOIN account_combinations combination
           ON combination.organization_id=journal_line.organization_id
          AND combination.id=journal_line.account_combination_id
         LEFT JOIN tax_account_mapping_lines mapping
           ON mapping.organization_id=combination.organization_id
          AND mapping.mapping_set_id=$5::uuid
          AND mapping.gl_account_id=combination.account_id
         LEFT JOIN source_documents source
           ON source.organization_id=journal.organization_id AND source.id=journal.source_document_id
         WHERE journal.organization_id=$1 AND journal.ledger_id=$2
           AND journal.status='POSTED'
           AND journal.accounting_date BETWEEN $3::date AND $4::date
           AND (journal_line.tax_snapshot_id IS NOT NULL OR mapping.id IS NOT NULL)
         ORDER BY "accountingDate", "journalEntryId"
         LIMIT ${MAX_REFERENCE_ROWS + 1}`,
        [principal.organizationId, filing.ledgerId, filing.periodStart, filing.periodEnd, filing.mappingSetId],
      ),
    ]);
    if (registrations.rows.length > 100
      || mappings.rows.length > MAX_MAPPING_ROWS
      || determinations.rows.length > MAX_DETERMINATION_ROWS
      || adjustments.rows.length > MAX_ADJUSTMENT_ROWS
      || references.rows.length > MAX_REFERENCE_ROWS) {
      throw Object.assign(
        new Error("The workpaper population exceeds the bounded export limit. Narrow or archive the filing population before retrying."),
        { code: "TAX_EXPORT_POPULATION_LIMIT" },
      );
    }
    const unresolved = Array.isArray(filing.reconciliation)
      ? filing.reconciliation.filter((entry) => entry && typeof entry === "object" && (entry as { status?: unknown }).status !== "MATCHED").length
      : 0;
    return {
      schemaVersion: 1,
      exportBoundary: "REVIEW_ONLY_NO_SUBMISSION_NO_PAYMENT",
      workpaperVersion: 1,
      unresolvedVarianceCount: unresolved,
      filing,
      registrations: registrations.rows,
      mappedLedgerBalances: mappings.rows,
      taxDeterminations: determinations.rows,
      assetBookToTaxAdjustments: adjustments.rows,
      sourceJournalReferences: references.rows,
      integrity: { logicalOrdering: "stable", authorizationRechecked: true },
    };
  });
}

export async function listTaxFilingWorkpapers(
  principal: SessionPrincipal,
  raw: z.input<typeof taxFilingWorkpaperListSchema>,
) {
  const command = taxFilingWorkpaperListSchema.parse(raw);
  return withWorkspaceTenantRead(context(principal), "/app/tax", async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readTax,
    });
    const result = await client.query(
      `SELECT filing.id AS "filingId", 1 AS "workpaperVersion", filing.filing_type AS "filingType",
         filing.status, filing.period_start::text AS "periodStart", filing.period_end::text AS "periodEnd",
         filing.legal_entity_id AS "legalEntityId", entity.code AS "entityCode",
         filing.ledger_id AS "ledgerId", ledger.code AS "ledgerCode",
         filing.template_id AS "templateId", template.template_key AS "templateKey",
         template.version AS "templateVersion", template.form_code AS "formCode",
         filing.mapping_set_id AS "mappingSetId", mapping.version AS "mappingVersion",
         filing.created_by AS "preparedBy", filing.created_at::text AS "preparedAt"
       FROM tax_filings filing
       JOIN legal_entities entity
         ON entity.organization_id=filing.organization_id AND entity.id=filing.legal_entity_id
       JOIN ledgers ledger
         ON ledger.organization_id=filing.organization_id AND ledger.id=filing.ledger_id
       JOIN tax_filing_templates template ON template.id=filing.template_id
       JOIN tax_account_mapping_sets mapping
         ON mapping.organization_id=filing.organization_id AND mapping.id=filing.mapping_set_id
       WHERE filing.organization_id=$1 AND ($2::uuid IS NULL OR filing.legal_entity_id=$2)
       ORDER BY filing.period_end DESC, filing.created_at DESC, filing.id
       LIMIT $3`,
      [principal.organizationId, command.legalEntityId ?? null, command.limit],
    );
    return { workpapers: result.rows };
  });
}

export async function previewTaxFilingExport(principal: SessionPrincipal, filingId: string) {
  const payload = await buildPackage(principal, z.uuid().parse(filingId));
  const serialized = canonical(payload);
  return {
    filingId,
    workpaperVersion: 1,
    contentHash: createHash("sha256").update(serialized, "utf8").digest("hex"),
    jsonByteSize: Buffer.byteLength(serialized),
    csvByteSize: Buffer.byteLength(packageCsv(payload)),
    formats: ["JSON", "CSV"] as const,
    unresolvedVarianceCount: payload.unresolvedVarianceCount,
    boundary: payload.exportBoundary,
  };
}

export async function exportTaxFilingWorkpaper(
  principal: SessionPrincipal,
  raw: z.input<typeof taxFilingExportSchema>,
) {
  const command = taxFilingExportSchema.parse(raw);
  const payload = await buildPackage(principal, command.filingId);
  const logical = canonical(payload);
  const contentHash = createHash("sha256").update(logical, "utf8").digest("hex");
  if (command.expectedContentHash && command.expectedContentHash !== contentHash) {
    throw Object.assign(new Error("The workpaper content changed since export preview. Preview the exact immutable version again."), { code: "TAX_EXPORT_HASH_CONFLICT" });
  }
  const body = command.format === "JSON" ? logical : packageCsv(payload);
  if (Buffer.byteLength(body) > MAX_EXPORT_BYTES) {
    throw Object.assign(
      new Error("The deterministic workpaper export exceeds the 8 MiB transfer limit."),
      { code: "TAX_EXPORT_SIZE_LIMIT" },
    );
  }
  return {
    filingId: command.filingId,
    workpaperVersion: 1,
    format: command.format,
    filename: `finlynq-tax-workpaper-${command.filingId}.${command.format.toLowerCase()}`,
    mimeType: command.format === "JSON" ? "application/json" : "text/csv; charset=utf-8",
    contentHash,
    downloadSha256: createHash("sha256").update(body, "utf8").digest("hex"),
    byteSize: Buffer.byteLength(body),
    contentBase64: Buffer.from(body, "utf8").toString("base64"),
    boundary: payload.exportBoundary,
  };
}
