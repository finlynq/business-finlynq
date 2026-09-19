import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { queryDatabase, withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { exact } from "@/kernel/money";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { canonicalHash, businessDocumentSnapshotSchema } from "@/modules/subledger/document-model";
import { decryptEvidenceContent, type EvidenceRow } from "@/modules/subledger/evidence-store";
import { uploadDocumentEvidence } from "@/modules/subledger/evidence-service";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";
import { decryptField, parseEncryptedField } from "@/security/organization-encryption";
import { loadOrganizationKeyVersion } from "@/security/organization-key-store";
import { safeFilenamePart } from "@/modules/document-storage/model";
import { activeEmailKeyVersion, decryptEmailValue, encryptEmailValue } from "./crypto";
import { INVOICE_PDF_TEMPLATE_VERSION, renderInvoicePdf } from "./invoice-pdf";
import {
  generateInvoicePdfSchema,
  invoiceRenderFactsSchema,
  paymentInstructionDetailsSchema,
  sendInvoiceSchema,
  type InvoiceRenderFacts,
} from "./model";
import { loadPaymentProfileDetails } from "./configuration";
import { ResendOutboundProvider, type OutboundEmailProvider } from "./provider";
import type { SubledgerDocumentRecord } from "@/modules/subledger/ar-ap-types";
import { emailResendApiKey } from "./secrets";

type ContextCommand = Readonly<{ context: TenantTransactionContext }>;
function withoutContext<T extends ContextCommand>(value: T): Omit<T, "context"> {
  const { context, ...command } = value;
  void context;
  return command;
}

type SourceRow = Readonly<{
  id: string; organization_id: string; owner_module: string; source_type: string; source_number: string;
  legal_entity_id: string; version: number; status: "DRAFT" | "POSTED" | "VOIDED";
  snapshot: unknown; content_hash: string; created_by: string;
}>;

type PdfArtifactRow = Readonly<{
  id: string; organization_id: string; source_document_id: string; source_version: number;
  source_content_hash: string; template_version: string; payment_profile_id: string | null;
  payment_profile_version: number | null; asset_id: string; preview: boolean; sha256: string;
  render_facts: Record<string, unknown>; render_facts_ciphertext: string; key_version: number;
  created_by: string; created_at: Date;
}>;

type DeliveryAttemptRow = Readonly<{
  id: string; organization_id: string; source_document_id: string; source_version: number;
  source_content_hash: string; pdf_artifact_id: string; provider: "RESEND";
  provider_message_id: string | null; recipients_ciphertext: string; key_version: number;
  template_version: string; idempotency_key: string; command_hash: string;
  status: "QUEUED" | "SENT" | "DELIVERED" | "BOUNCED" | "COMPLAINED" | "FAILED";
  failure_code: string | null; retry_count: number; next_retry_at: Date | null;
  manual_resend: boolean; created_by: string; created_at: Date; updated_at: Date;
}>;

async function assertReceivablesRead(client: PoolClient, context: TenantTransactionContext) {
  await assertActorHasActivePermission(client, {
    organizationId: context.organizationId,
    actorId: context.actorId,
    permission: PERMISSIONS.readReceivables,
  });
}

async function assertReceivablesWrite(client: PoolClient, context: TenantTransactionContext) {
  assertTenantWritesEnabled(context);
  await assertWritableOrganization(client, context);
  await assertActorHasActivePermission(client, {
    organizationId: context.organizationId,
    actorId: context.actorId,
    permission: PERMISSIONS.manageReceivables,
  });
}

async function exactSalesInvoice(
  client: PoolClient,
  context: TenantTransactionContext,
  id: string,
  expectedVersion: number,
  expectedContentHash: string,
  lock = false,
): Promise<{ row: SourceRow; snapshot: ReturnType<typeof businessDocumentSnapshotSchema.parse> }> {
  const row = (await client.query<SourceRow>(
    `SELECT id,organization_id,owner_module,source_type,source_number,legal_entity_id,version,status,snapshot,content_hash,created_by
     FROM source_documents WHERE organization_id=$1 AND id=$2${lock ? " FOR SHARE" : ""}`,
    [context.organizationId, id],
  )).rows[0];
  if (!row || row.source_type !== "receivables.sales-invoice" || row.owner_module !== "receivables"
      || row.version !== expectedVersion || row.content_hash !== expectedContentHash) {
    throw new Error("Invoice rendering requires the exact tenant-owned source version and content hash");
  }
  return { row, snapshot: businessDocumentSnapshotSchema.parse(row.snapshot) };
}

async function decryptPartyName(client: PoolClient, organizationId: string, partyAccountId: string) {
  const row = (await client.query<{
    id: string; display_name_ciphertext: string; display_name_key_version: number;
  }>(
    `SELECT party.id,party.display_name_ciphertext,party.display_name_key_version
     FROM party_accounts account JOIN parties party
       ON party.organization_id=account.organization_id AND party.id=account.party_id
     WHERE account.organization_id=$1 AND account.id=$2 AND account.role='CUSTOMER'`,
    [organizationId, partyAccountId],
  )).rows[0];
  if (!row) throw new Error("Invoice customer is unavailable");
  const key = await loadOrganizationKeyVersion(client, organizationId, row.display_name_key_version);
  try {
    return decryptField(parseEncryptedField(row.display_name_ciphertext), key.dek, {
      organizationId, table: "parties", column: "display_name_ciphertext", recordId: row.id,
      keyVersion: row.display_name_key_version,
    });
  } finally { key.dek.fill(0); }
}

const addressPayloadSchema = z.object({
  line1: z.string(), line2: z.string().optional(), city: z.string(), region: z.string(),
  postalCode: z.string(), countryCode: z.string(),
}).strict();

async function decryptBillingAddress(client: PoolClient, organizationId: string, partyAccountId: string) {
  const row = (await client.query<{
    id: string; ciphertext: string; key_version: string;
  }>(
    `SELECT address.id,address.ciphertext,address.key_version
     FROM party_accounts account JOIN party_addresses address
       ON address.organization_id=account.organization_id AND address.party_id=account.party_id
     WHERE account.organization_id=$1 AND account.id=$2 AND address.kind='BILLING'
       AND address.valid_from<=current_date AND (address.valid_to IS NULL OR address.valid_to>=current_date)
     ORDER BY address.valid_from DESC,address.id LIMIT 1`,
    [organizationId, partyAccountId],
  )).rows[0];
  if (!row) return [];
  const keyVersion = Number(row.key_version);
  const key = await loadOrganizationKeyVersion(client, organizationId, keyVersion);
  try {
    const value = decryptField(parseEncryptedField(row.ciphertext), key.dek, {
      organizationId, table: "party_addresses", column: "ciphertext", recordId: row.id, keyVersion,
    });
    const address = addressPayloadSchema.parse(JSON.parse(value));
    return [address.line1, address.line2, `${address.city}, ${address.region} ${address.postalCode}`, address.countryCode].filter((part): part is string => Boolean(part));
  } finally { key.dek.fill(0); }
}

async function decryptTaxRegistrations(client: PoolClient, organizationId: string, entityId: string, date: string) {
  const rows = await client.query<{
    id: string; regime_key: string; registration_ciphertext: string; key_version: string;
  }>(
    `SELECT id,regime_key,registration_ciphertext,key_version FROM entity_tax_registrations
     WHERE organization_id=$1 AND legal_entity_id=$2 AND valid_from<=$3
       AND (valid_to IS NULL OR valid_to>=$3) ORDER BY regime_key,id`,
    [organizationId, entityId, date],
  );
  const values: string[] = [];
  for (const row of rows.rows) {
    const keyVersion = Number(row.key_version);
    const key = await loadOrganizationKeyVersion(client, organizationId, keyVersion);
    try {
      const registration = decryptField(parseEncryptedField(row.registration_ciphertext), key.dek, {
        organizationId, table: "entity_tax_registrations", column: "registration_ciphertext", recordId: row.id, keyVersion,
      });
      values.push(`${row.regime_key}: ${registration}`);
    } finally { key.dek.fill(0); }
  }
  return values;
}

function paymentInstructionLines(details: ReturnType<typeof paymentInstructionDetailsSchema.parse>): string[] {
  return [
    `Beneficiary: ${details.beneficiaryName}`,
    details.bankName ? `Bank: ${details.bankName}` : undefined,
    details.institutionNumber ? `Institution: ${details.institutionNumber}` : undefined,
    details.transitNumber ? `Transit: ${details.transitNumber}` : undefined,
    details.accountNumber ? `Account: ${details.accountNumber}` : undefined,
    details.routingNumber ? `Routing / ABA: ${details.routingNumber}` : undefined,
    details.swiftBic ? `SWIFT / BIC: ${details.swiftBic}` : undefined,
    details.iban ? `IBAN: ${details.iban}` : undefined,
    details.remittanceEmail ? `Remittance email: ${details.remittanceEmail}` : undefined,
    `Accepted methods: ${details.acceptedMethods.join(", ")}`,
    details.paymentReferenceWording,
    details.instructions,
  ].filter((line): line is string => Boolean(line));
}

async function buildRenderFacts(
  client: PoolClient,
  context: TenantTransactionContext,
  source: { row: SourceRow; snapshot: ReturnType<typeof businessDocumentSnapshotSchema.parse> },
  paymentProfileId: string | undefined,
  preview: boolean,
) {
  const entity = (await client.query<{ display_name: string; country_code: string; region_code: string }>(
    "SELECT display_name,country_code,region_code FROM legal_entities WHERE organization_id=$1 AND id=$2",
    [context.organizationId, source.snapshot.legalEntityId],
  )).rows[0];
  if (!entity) throw new Error("Invoice legal entity is unavailable");
  const organization = (await client.query<{ display_name: string }>(
    "SELECT display_name FROM organizations WHERE id=$1", [context.organizationId],
  )).rows[0];
  const customerName = await decryptPartyName(client, context.organizationId, source.snapshot.partyAccountId);
  const customerAddress = await decryptBillingAddress(client, context.organizationId, source.snapshot.partyAccountId);
  const taxRegistrations = await decryptTaxRegistrations(client, context.organizationId, source.snapshot.legalEntityId, source.snapshot.documentDate);
  const profile = paymentProfileId ? await loadPaymentProfileDetails(client, context.organizationId, paymentProfileId) : null;
  if (profile && (profile.row.legal_entity_id !== source.snapshot.legalEntityId || profile.row.currency_code !== source.snapshot.currency)) {
    throw new Error("Payment profile does not match the invoice legal entity and currency");
  }
  const lines = source.snapshot.lines.map((line) => {
    const tax = line.taxDecision.totalTax;
    return {
      description: line.description,
      quantity: "1",
      unitPrice: line.netAmount,
      netAmount: line.netAmount,
      taxAmount: tax,
      grossAmount: exact(line.netAmount).plus(exact(tax)).toFixed(2),
    };
  });
  const facts = invoiceRenderFactsSchema.parse({
    organizationName: organization?.display_name ?? entity.display_name,
    legalEntityName: entity.display_name,
    legalEntityAddress: [`${entity.region_code}, ${entity.country_code}`],
    taxRegistrations,
    customerName,
    customerAddress,
    invoiceNumber: source.row.source_number,
    invoiceDate: source.snapshot.documentDate,
    dueDate: source.snapshot.dueOn,
    terms: source.snapshot.description,
    currency: source.snapshot.currency,
    lines,
    netTotal: source.snapshot.subtotal,
    taxTotal: source.snapshot.taxTotal,
    grossTotal: source.snapshot.grossTotal,
    paymentInstructions: profile ? paymentInstructionLines(profile.details) : [],
    preview,
  });
  return { facts, profile: profile?.row ?? null };
}

function artifactDto(row: PdfArtifactRow) {
  return {
    id: row.id, sourceDocumentId: row.source_document_id, sourceVersion: row.source_version,
    sourceContentHash: row.source_content_hash, templateVersion: row.template_version,
    paymentProfileId: row.payment_profile_id, paymentProfileVersion: row.payment_profile_version,
    assetId: row.asset_id, preview: row.preview, sha256: row.sha256,
    createdAt: row.created_at.toISOString(),
    downloadUrl: `/api/receivables/invoice-pdfs/${row.id}`,
  };
}

export async function generateInvoicePdf(unparsed: ContextCommand & z.input<typeof generateInvoicePdfSchema>) {
  const command = generateInvoicePdfSchema.parse(withoutContext(unparsed));
  const prepared = await withTenantTransaction(unparsed.context, async (client) => {
    await assertReceivablesWrite(client, unparsed.context);
    const existing = (await client.query<PdfArtifactRow>(
      `SELECT * FROM sales_invoice_pdf_artifacts WHERE organization_id=$1 AND source_document_id=$2
         AND source_version=$3 AND source_content_hash=$4 AND template_version=$5 AND preview=$6
         AND payment_profile_id IS NOT DISTINCT FROM $7`,
      [unparsed.context.organizationId, command.sourceDocumentId, command.expectedVersion,
        command.expectedContentHash, INVOICE_PDF_TEMPLATE_VERSION, command.preview,
        command.paymentInstructionProfileId ?? null],
    )).rows[0];
    if (existing) return { replay: existing, prepared: null };
    const source = await exactSalesInvoice(client, unparsed.context, command.sourceDocumentId, command.expectedVersion, command.expectedContentHash, true);
    if (!command.preview && source.row.status !== "POSTED") throw new Error("Only a posted sales invoice can receive an issued PDF");
    if (command.preview && source.row.status === "VOIDED") throw new Error("A voided invoice cannot be previewed as current");
    const rendered = await buildRenderFacts(client, unparsed.context, source, command.paymentInstructionProfileId, command.preview);
    return { replay: null, prepared: { source, ...rendered } };
  });
  if (prepared.replay) return { artifact: artifactDto(prepared.replay), idempotentReplay: true };
  const facts = prepared.prepared!.facts;
  const pdf = renderInvoicePdf(facts);
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  try {
    const uploaded = await uploadDocumentEvidence({
      context: unparsed.context,
      module: "receivables",
      filename: `${safeFilenamePart(facts.invoiceNumber, 80)}${facts.preview ? "-preview" : ""}.pdf`,
      mimeType: "application/pdf",
      byteSize: pdf.length,
      sha256,
      contentBase64: pdf.toString("base64"),
      idempotencyKey: `invoice-pdf:${command.sourceDocumentId}:${command.expectedVersion}:${command.expectedContentHash}:${command.preview}:${command.paymentInstructionProfileId ?? "none"}`,
    });
    return await withTenantTransaction(unparsed.context, async (client) => {
      await assertReceivablesWrite(client, unparsed.context);
      await exactSalesInvoice(client, unparsed.context, command.sourceDocumentId, command.expectedVersion, command.expectedContentHash, true);
      const replay = (await client.query<PdfArtifactRow>(
        `SELECT * FROM sales_invoice_pdf_artifacts WHERE organization_id=$1 AND source_document_id=$2
           AND source_version=$3 AND source_content_hash=$4 AND template_version=$5 AND preview=$6
           AND payment_profile_id IS NOT DISTINCT FROM $7`,
        [unparsed.context.organizationId, command.sourceDocumentId, command.expectedVersion,
          command.expectedContentHash, INVOICE_PDF_TEMPLATE_VERSION, command.preview,
          command.paymentInstructionProfileId ?? null],
      )).rows[0];
      if (replay) return { artifact: artifactDto(replay), idempotentReplay: true };
      const id = randomUUID();
      const scope = { id, organization_id: unparsed.context.organizationId, key_version: await activeEmailKeyVersion(client, unparsed.context.organizationId) };
      const encryptedFacts = await encryptEmailValue(client, scope, "sales_invoice_pdf_artifacts", "render_facts_ciphertext", facts);
      const safeFacts = {
        invoiceNumberHash: createHash("sha256").update(facts.invoiceNumber).digest("hex"),
        currency: facts.currency,
        lineCount: facts.lines.length,
        netTotal: facts.netTotal,
        taxTotal: facts.taxTotal,
        grossTotal: facts.grossTotal,
      };
      const inserted = (await client.query<PdfArtifactRow>(
        `INSERT INTO sales_invoice_pdf_artifacts
         (id,organization_id,source_document_id,source_version,source_content_hash,template_version,payment_profile_id,payment_profile_version,asset_id,preview,sha256,render_facts,render_facts_ciphertext,key_version,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [id, unparsed.context.organizationId, command.sourceDocumentId, command.expectedVersion,
          command.expectedContentHash, INVOICE_PDF_TEMPLATE_VERSION, prepared.prepared!.profile?.id ?? null,
          prepared.prepared!.profile?.version ?? null, uploaded.asset.assetId, command.preview, sha256,
          safeFacts, encryptedFacts, scope.key_version, unparsed.context.actorId],
      )).rows[0];
      return { artifact: artifactDto(inserted), idempotentReplay: false };
    });
  } finally { pdf.fill(0); }
}

export async function listInvoicePdfArtifacts(context: TenantTransactionContext, sourceDocumentId: string) {
  const id = z.uuid().parse(sourceDocumentId);
  return withTenantTransaction(context, async (client) => {
    await assertReceivablesRead(client, context);
    const rows = await client.query<PdfArtifactRow>(
      "SELECT * FROM sales_invoice_pdf_artifacts WHERE organization_id=$1 AND source_document_id=$2 ORDER BY created_at,id",
      [context.organizationId, id],
    );
    return rows.rows.map(artifactDto);
  });
}

export async function downloadInvoicePdf(context: TenantTransactionContext, artifactId: string) {
  const id = z.uuid().parse(artifactId);
  return withTenantTransaction(context, async (client) => {
    await assertReceivablesRead(client, context);
    const artifact = (await client.query<PdfArtifactRow>(
      "SELECT * FROM sales_invoice_pdf_artifacts WHERE organization_id=$1 AND id=$2", [context.organizationId, id],
    )).rows[0];
    if (!artifact) throw new Error("Invoice PDF is unavailable");
    const evidence = (await client.query<EvidenceRow & { content_ciphertext: string }>(
      "SELECT * FROM document_evidence_assets WHERE organization_id=$1 AND id=$2 AND owner_module='receivables' AND storage_backend='DATABASE'",
      [context.organizationId, artifact.asset_id],
    )).rows[0];
    if (!evidence) throw new Error("Invoice PDF evidence is unavailable");
    const bytes = await decryptEvidenceContent(client, evidence);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
      bytes.fill(0); throw new Error("Invoice PDF integrity check failed");
    }
    const source = await client.query<{ source_number: string }>(
      "SELECT source_number FROM source_documents WHERE organization_id=$1 AND id=$2",
      [context.organizationId, artifact.source_document_id],
    );
    return { bytes, filename: `${safeFilenamePart(source.rows[0]?.source_number ?? "Invoice", 80)}.pdf`, artifact: artifactDto(artifact) };
  });
}

function outboundProvider(): OutboundEmailProvider {
  const apiKey = emailResendApiKey();
  if (!apiKey) throw Object.assign(new Error("Outbound email provider is not configured"), { code: "EMAIL_NOT_CONFIGURED" });
  return new ResendOutboundProvider(apiKey);
}

function fromAddress(): string {
  const domain = process.env.BUSINESS_FINLYNQ_OUTBOUND_EMAIL_DOMAIN?.trim().toLocaleLowerCase("en-US");
  if (!domain) throw Object.assign(new Error("Outbound email domain is not configured"), { code: "EMAIL_NOT_CONFIGURED" });
  return `Business FinLynQ <billing@${domain}>`;
}

async function prepareDelivery(unparsed: ContextCommand & z.input<typeof sendInvoiceSchema>) {
  const command = sendInvoiceSchema.parse(withoutContext(unparsed));
  const idempotencyKey = `invoice-delivery:${canonicalHash(command.idempotencyKey)}`;
  const commandHash = canonicalHash(command);
  return withTenantTransaction({ ...unparsed.context, reason: command.reason }, async (client) => {
    await assertReceivablesWrite(client, unparsed.context);
    const replay = (await client.query<DeliveryAttemptRow>(
      "SELECT * FROM invoice_delivery_attempts WHERE organization_id=$1 AND idempotency_key=$2",
      [unparsed.context.organizationId, idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error("Invoice delivery idempotency key was already used differently");
      return { command, attempt: replay, bytes: null, filename: null, replay: true };
    }
    const source = await exactSalesInvoice(client, unparsed.context, command.sourceDocumentId, command.expectedVersion, command.expectedContentHash, true);
    if (source.row.status !== "POSTED") throw new Error("Only a posted sales invoice can be delivered");
    const preference = (await client.query<{ suppression_status: string }>(
      "SELECT suppression_status FROM customer_delivery_preferences WHERE organization_id=$1 AND party_account_id=$2",
      [unparsed.context.organizationId, source.snapshot.partyAccountId],
    )).rows[0];
    if (preference && preference.suppression_status !== "NONE") throw Object.assign(new Error("Automatic and manual delivery are suppressed after a hard bounce or complaint; correct and re-enable the recipient first"), { code: "EMAIL_RECIPIENT_SUPPRESSED" });
    const artifact = (await client.query<PdfArtifactRow>(
      `SELECT * FROM sales_invoice_pdf_artifacts WHERE organization_id=$1 AND id=$2
         AND source_document_id=$3 AND source_version=$4 AND source_content_hash=$5 AND preview=false`,
      [unparsed.context.organizationId, command.pdfArtifactId, source.row.id, source.row.version, source.row.content_hash],
    )).rows[0];
    if (!artifact) throw new Error("Delivery requires the exact issued invoice PDF artifact");
    const evidence = (await client.query<EvidenceRow & { content_ciphertext: string }>(
      "SELECT * FROM document_evidence_assets WHERE organization_id=$1 AND id=$2 AND storage_backend='DATABASE'",
      [unparsed.context.organizationId, artifact.asset_id],
    )).rows[0];
    if (!evidence) throw new Error("Invoice PDF evidence is unavailable");
    const bytes = await decryptEvidenceContent(client, evidence);
    const id = randomUUID();
    const scope = { id, organization_id: unparsed.context.organizationId, key_version: await activeEmailKeyVersion(client, unparsed.context.organizationId) };
    const recipients = await encryptEmailValue(client, scope, "invoice_delivery_attempts", "recipients_ciphertext", {
      to: command.recipients, cc: command.ccRecipients, subject: command.subject, message: command.message,
    });
    const attempt = (await client.query<DeliveryAttemptRow>(
      `INSERT INTO invoice_delivery_attempts
       (id,organization_id,source_document_id,source_version,source_content_hash,pdf_artifact_id,provider,recipients_ciphertext,key_version,template_version,idempotency_key,command_hash,status,manual_resend,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'RESEND',$7,$8,$9,$10,$11,'QUEUED',$12,$13) RETURNING *`,
      [id, unparsed.context.organizationId, source.row.id, source.row.version, source.row.content_hash,
        artifact.id, recipients, scope.key_version, artifact.template_version, idempotencyKey, commandHash,
        command.manualResend, unparsed.context.actorId],
    )).rows[0];
    return { command, attempt, bytes, filename: `${safeFilenamePart(source.row.source_number, 80)}.pdf`, replay: false };
  });
}

function deliveryDto(row: DeliveryAttemptRow) {
  return {
    id: row.id, sourceDocumentId: row.source_document_id, sourceVersion: row.source_version,
    pdfArtifactId: row.pdf_artifact_id, provider: row.provider, providerMessageId: row.provider_message_id,
    status: row.status, failureCode: row.failure_code, retryCount: row.retry_count,
    manualResend: row.manual_resend, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

export async function sendInvoice(unparsed: ContextCommand & z.input<typeof sendInvoiceSchema>, provider?: OutboundEmailProvider) {
  const prepared = await prepareDelivery(unparsed);
  if (prepared.replay && prepared.attempt.status !== "QUEUED" && prepared.attempt.status !== "FAILED") {
    return { delivery: deliveryDto(prepared.attempt), idempotentReplay: true };
  }
  let bytes = prepared.bytes;
  if (!bytes) {
    const download = await downloadInvoicePdf(unparsed.context, prepared.attempt.pdf_artifact_id);
    bytes = download.bytes;
  }
  try {
    const result = await (provider ?? outboundProvider()).send({
      from: fromAddress(), to: prepared.command.recipients, cc: prepared.command.ccRecipients,
      subject: prepared.command.subject, text: prepared.command.message,
      filename: prepared.filename ?? "Invoice.pdf", pdf: bytes,
      idempotencyKey: prepared.attempt.idempotency_key,
    });
    return await withTenantTransaction(unparsed.context, async (client) => {
      await assertReceivablesWrite(client, unparsed.context);
      const updated = (await client.query<DeliveryAttemptRow>(
        `UPDATE invoice_delivery_attempts SET status='SENT',provider_message_id=$3,failure_code=NULL,next_retry_at=NULL,updated_at=now()
         WHERE organization_id=$1 AND id=$2 AND status IN ('QUEUED','FAILED') RETURNING *`,
        [unparsed.context.organizationId, prepared.attempt.id, result.providerMessageId],
      )).rows[0];
      return { delivery: deliveryDto(updated ?? prepared.attempt), idempotentReplay: prepared.replay };
    });
  } catch (error) {
    await withTenantTransaction(unparsed.context, async (client) => {
      await client.query(
        `UPDATE invoice_delivery_attempts SET status='FAILED',failure_code='PROVIDER_UNAVAILABLE',retry_count=retry_count+1,
           next_retry_at=now()+interval '5 minutes',updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [unparsed.context.organizationId, prepared.attempt.id],
      );
    });
    throw error;
  } finally { bytes.fill(0); }
}

export async function listInvoiceDeliveries(context: TenantTransactionContext, sourceDocumentId?: string) {
  const id = sourceDocumentId ? z.uuid().parse(sourceDocumentId) : null;
  return withTenantTransaction(context, async (client) => {
    await assertReceivablesRead(client, context);
    const rows = await client.query<DeliveryAttemptRow>(
      `SELECT * FROM invoice_delivery_attempts WHERE organization_id=$1
       AND ($2::uuid IS NULL OR source_document_id=$2) ORDER BY created_at DESC,id DESC LIMIT 100`,
      [context.organizationId, id],
    );
    return rows.rows.map(deliveryDto);
  });
}

export async function previewInvoiceDelivery(context: TenantTransactionContext, sourceDocumentId: string) {
  const id = z.uuid().parse(sourceDocumentId);
  return withTenantTransaction(context, async (client) => {
    await assertReceivablesRead(client, context);
    const source = (await client.query<SourceRow>(
      `SELECT id,organization_id,owner_module,source_type,source_number,legal_entity_id,version,status,snapshot,content_hash,created_by
       FROM source_documents WHERE organization_id=$1 AND id=$2`, [context.organizationId, id],
    )).rows[0];
    if (!source || source.source_type !== "receivables.sales-invoice") throw new Error("Sales invoice is unavailable");
    const snapshot = businessDocumentSnapshotSchema.parse(source.snapshot);
    const preference = (await client.query<{
      id: string; organization_id: string; preferences_ciphertext: string; key_version: number;
      version: number; delivery_method: string; auto_send_on_issue: boolean; payment_profile_id: string | null; suppression_status: string;
    }>(
      "SELECT * FROM customer_delivery_preferences WHERE organization_id=$1 AND party_account_id=$2",
      [context.organizationId, snapshot.partyAccountId],
    )).rows[0];
    const recipients = preference
      ? z.object({ billingRecipients: z.array(z.string()), ccRecipients: z.array(z.string()) }).passthrough().parse(
          await decryptEmailValue(client, preference, "customer_delivery_preferences", "preferences_ciphertext", preference.preferences_ciphertext),
        )
      : { billingRecipients: [], ccRecipients: [] };
    const policy = (await client.query<{ outbound_enabled: boolean; auto_send_enabled: boolean }>(
      "SELECT outbound_enabled,auto_send_enabled FROM email_delivery_settings WHERE organization_id=$1", [context.organizationId],
    )).rows[0] ?? { outbound_enabled: false, auto_send_enabled: false };
    const artifacts = await client.query<PdfArtifactRow>(
      "SELECT * FROM sales_invoice_pdf_artifacts WHERE organization_id=$1 AND source_document_id=$2 ORDER BY created_at DESC",
      [context.organizationId, source.id],
    );
    return {
      sourceDocumentId: source.id, sourceNumber: source.source_number, version: source.version,
      contentHash: source.content_hash, status: source.status,
      recipients: recipients.billingRecipients, ccRecipients: recipients.ccRecipients,
      deliveryMethod: preference?.delivery_method ?? "MANUAL",
      suppressionStatus: preference?.suppression_status ?? "NONE",
      paymentProfileId: preference?.payment_profile_id ?? null,
      organizationOutboundEnabled: policy.outbound_enabled,
      autoSendEligible: policy.outbound_enabled && policy.auto_send_enabled
        && preference?.delivery_method === "EMAIL" && preference?.auto_send_on_issue === true
        && preference.suppression_status === "NONE" && recipients.billingRecipients.length > 0,
      pdfArtifacts: artifacts.rows.map(artifactDto),
    };
  });
}

/**
 * Runs only after the accounting transaction has committed. Delivery failures are
 * deliberately returned as a side-effect outcome and can never roll back a
 * posted invoice.
 */
export async function attemptAutomaticInvoiceDelivery(
  context: TenantTransactionContext,
  document: SubledgerDocumentRecord,
) {
  if (document.sourceType !== "receivables.sales-invoice" || document.status !== "POSTED") {
    return { status: "SKIPPED" as const, reason: "NOT_A_POSTED_SALES_INVOICE" as const };
  }
  try {
    const preview = await previewInvoiceDelivery(context, document.id);
    if (!preview.autoSendEligible) {
      return { status: "SKIPPED" as const, reason: "AUTOMATIC_DELIVERY_NOT_ENABLED" as const };
    }
    const generated = await generateInvoicePdf({
      context,
      sourceDocumentId: document.id,
      expectedVersion: document.version,
      expectedContentHash: document.contentHash,
      paymentInstructionProfileId: preview.paymentProfileId ?? undefined,
      preview: false,
      idempotencyKey: `auto-invoice-pdf:${document.id}:${document.version}`,
    });
    const sent = await sendInvoice({
      context,
      sourceDocumentId: document.id,
      expectedVersion: document.version,
      expectedContentHash: document.contentHash,
      pdfArtifactId: generated.artifact.id,
      recipients: preview.recipients,
      ccRecipients: preview.ccRecipients,
      subject: `Invoice ${document.sourceNumber}`,
      message: `Please find invoice ${document.sourceNumber} attached.`,
      idempotencyKey: `auto-invoice-delivery:${document.id}:${document.version}`,
      manualResend: false,
      reason: "Automatic delivery after invoice issue",
    });
    return { status: "SENT" as const, artifact: generated.artifact, delivery: sent.delivery };
  } catch (error) {
    const candidate = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "AUTOMATIC_DELIVERY_FAILED";
    const failureCode = new Set([
      "EMAIL_NOT_CONFIGURED", "EMAIL_RECIPIENT_SUPPRESSED", "PROVIDER_UNAVAILABLE",
    ]).has(candidate) ? candidate : "AUTOMATIC_DELIVERY_FAILED";
    return { status: "FAILED" as const, failureCode };
  }
}

const storedDeliveryPayloadSchema = z.object({
  to: z.array(z.string()).min(1), cc: z.array(z.string()), subject: z.string(), message: z.string(),
}).strict();

export async function retryInvoiceDelivery(
  context: TenantTransactionContext,
  attemptId: string,
  provider?: OutboundEmailProvider,
) {
  const id = z.uuid().parse(attemptId);
  const prepared = await withTenantTransaction(context, async (client) => {
    await assertReceivablesWrite(client, context);
    const attempt = (await client.query<DeliveryAttemptRow>(
      "SELECT * FROM invoice_delivery_attempts WHERE organization_id=$1 AND id=$2 FOR UPDATE",
      [context.organizationId, id],
    )).rows[0];
    if (!attempt || attempt.status !== "FAILED" || attempt.retry_count >= 5) {
      throw new Error("Only a bounded failed invoice delivery can be retried");
    }
    const payload = storedDeliveryPayloadSchema.parse(await decryptEmailValue(
      client, attempt, "invoice_delivery_attempts", "recipients_ciphertext", attempt.recipients_ciphertext,
    ));
    const artifact = (await client.query<PdfArtifactRow>(
      "SELECT * FROM sales_invoice_pdf_artifacts WHERE organization_id=$1 AND id=$2 AND preview=false",
      [context.organizationId, attempt.pdf_artifact_id],
    )).rows[0];
    const evidence = artifact ? (await client.query<EvidenceRow & { content_ciphertext: string }>(
      "SELECT * FROM document_evidence_assets WHERE organization_id=$1 AND id=$2 AND storage_backend='DATABASE'",
      [context.organizationId, artifact.asset_id],
    )).rows[0] : null;
    if (!artifact || !evidence) throw new Error("Invoice delivery PDF is unavailable");
    const bytes = await decryptEvidenceContent(client, evidence);
    const source = await client.query<{ source_number: string }>(
      "SELECT source_number FROM source_documents WHERE organization_id=$1 AND id=$2",
      [context.organizationId, attempt.source_document_id],
    );
    return { attempt, payload, bytes, filename: `${safeFilenamePart(source.rows[0]?.source_number ?? "Invoice", 80)}.pdf` };
  });
  try {
    const result = await (provider ?? outboundProvider()).send({
      from: fromAddress(), to: prepared.payload.to, cc: prepared.payload.cc,
      subject: prepared.payload.subject, text: prepared.payload.message,
      filename: prepared.filename, pdf: prepared.bytes, idempotencyKey: prepared.attempt.idempotency_key,
    });
    return await withTenantTransaction(context, async (client) => {
      const updated = (await client.query<DeliveryAttemptRow>(
        `UPDATE invoice_delivery_attempts SET status='SENT',provider_message_id=$3,failure_code=NULL,
           retry_count=retry_count+1,next_retry_at=NULL,updated_at=now()
         WHERE organization_id=$1 AND id=$2 AND status='FAILED' RETURNING *`,
        [context.organizationId, prepared.attempt.id, result.providerMessageId],
      )).rows[0];
      return { delivery: deliveryDto(updated), idempotentReplay: false };
    });
  } catch (error) {
    await withTenantTransaction(context, async (client) => {
      await client.query(
        `UPDATE invoice_delivery_attempts SET retry_count=retry_count+1,
           next_retry_at=CASE WHEN retry_count+1<5 THEN now()+interval '15 minutes' ELSE NULL END,
           failure_code=CASE WHEN retry_count+1<5 THEN 'PROVIDER_UNAVAILABLE' ELSE 'DEAD_LETTER' END,updated_at=now()
         WHERE organization_id=$1 AND id=$2`, [context.organizationId, prepared.attempt.id],
      );
    });
    throw error;
  } finally { prepared.bytes.fill(0); }
}

const deliveryEventSchema = z.object({
  type: z.enum(["email.sent", "email.delivered", "email.bounced", "email.complained", "email.failed"]),
  created_at: z.iso.datetime({ offset: true }),
  data: z.object({ email_id: z.string().min(1).max(500) }).passthrough(),
}).passthrough();

type ResolvedAttempt = Readonly<{ organization_id: string; attempt_id: string; actor_id: string }>;
export async function recordOutboundDeliveryEvent(eventId: string, payload: unknown) {
  const event = deliveryEventSchema.parse(payload);
  const resolved = (await queryDatabase<ResolvedAttempt>(
    "SELECT * FROM app.resolve_outbound_email_attempt($1)", [event.data.email_id],
  )).rows[0];
  if (!resolved) return { accepted: true, matched: false };
  const context: TenantTransactionContext = {
    organizationId: resolved.organization_id, actorId: resolved.actor_id, sessionMode: "real",
    requestId: `email-event:${eventId}`.slice(0, 200), authMethod: "resend-webhook", sourceSurface: "WORKER",
    reason: "Verified outbound email delivery callback",
  };
  return withTenantTransaction(context, async (client) => {
    const exists = await client.query("SELECT 1 FROM invoice_delivery_events WHERE provider_event_id=$1", [eventId]);
    if (exists.rows[0]) return { accepted: true, matched: true, replay: true };
    const attempt = (await client.query<DeliveryAttemptRow>(
      "SELECT * FROM invoice_delivery_attempts WHERE organization_id=$1 AND id=$2 FOR UPDATE",
      [resolved.organization_id, resolved.attempt_id],
    )).rows[0];
    if (!attempt) return { accepted: true, matched: false };
    const requestedStatus = ({
      "email.sent": "SENT", "email.delivered": "DELIVERED", "email.bounced": "BOUNCED",
      "email.complained": "COMPLAINED", "email.failed": "FAILED",
    } as const)[event.type];
    const status = (attempt.status === "BOUNCED" || attempt.status === "COMPLAINED")
      ? attempt.status
      : attempt.status === "DELIVERED" && (requestedStatus === "SENT" || requestedStatus === "FAILED")
        ? "DELIVERED"
        : requestedStatus;
    await client.query(
      `INSERT INTO invoice_delivery_events(organization_id,attempt_id,provider_event_id,event_type,event_at,payload_summary)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [resolved.organization_id, attempt.id, eventId, event.type, event.created_at, { providerMessageId: event.data.email_id }],
    );
    await client.query(
      `UPDATE invoice_delivery_attempts SET status=$3,failure_code=$4,updated_at=now()
       WHERE organization_id=$1 AND id=$2`,
      [resolved.organization_id, attempt.id, status, status === "FAILED" ? "PROVIDER_FAILED" : null],
    );
    if (status === "BOUNCED" || status === "COMPLAINED") {
      const source = await client.query<{ snapshot: unknown }>(
        "SELECT snapshot FROM source_documents WHERE organization_id=$1 AND id=$2",
        [resolved.organization_id, attempt.source_document_id],
      );
      const snapshot = businessDocumentSnapshotSchema.parse(source.rows[0]?.snapshot);
      await client.query(
        `UPDATE customer_delivery_preferences SET suppression_status=$3,version=version+1,updated_at=now()
         WHERE organization_id=$1 AND party_account_id=$2`,
        [resolved.organization_id, snapshot.partyAccountId, status === "BOUNCED" ? "HARD_BOUNCE" : "COMPLAINT"],
      );
    }
    return { accepted: true, matched: true, replay: false, status };
  });
}

export async function loadInvoiceRenderFacts(context: TenantTransactionContext, artifactId: string): Promise<InvoiceRenderFacts> {
  return withTenantTransaction(context, async (client) => {
    await assertReceivablesRead(client, context);
    const row = (await client.query<PdfArtifactRow>(
      "SELECT * FROM sales_invoice_pdf_artifacts WHERE organization_id=$1 AND id=$2", [context.organizationId, z.uuid().parse(artifactId)],
    )).rows[0];
    if (!row) throw new Error("Invoice PDF is unavailable");
    return invoiceRenderFactsSchema.parse(await decryptEmailValue(client, row, "sales_invoice_pdf_artifacts", "render_facts_ciphertext", row.render_facts_ciphertext));
  });
}
