import "server-only";
import type { PoolClient } from "pg";
import type { TenantTransactionContext } from "@/db/transaction";
import { assertPermission, permissionForOwner } from "@/modules/subledger/ar-ap-access";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { subledgerSourceSnapshotSchema } from "@/modules/subledger/document-model";
import type { SourceDocumentRow } from "@/modules/subledger/ar-ap-types";
import { buildIssueJournalLines, type JournalLineInput } from "@/modules/subledger/journal-line-builders";
import { loadDocumentEvidence } from "@/modules/subledger/evidence-store";
import { loadOrganizationKeyVersion } from "@/security/organization-key-store";
import { decryptField, parseEncryptedField } from "@/security/organization-encryption";
import type { BookingDefinition, BookingEntry, BookingLine, BookingRecord, BookingSnapshot } from "./model";
import { summarizeBookingEntries } from "./model";

type Header = { id: string; legal_entity_id: string; ledger_id: string; status: string; content_hash: string; approval_version: number | null;
  journal_number: number | null; journal_type_key: string; accounting_date: string; functional_currency: string; description: string;
  created_by: string; approved_by: string | null; posted_by: string | null; period: string };
async function journal(client: PoolClient, context: TenantTransactionContext, id: string): Promise<Header> {
  const row = (await client.query<Header>(`SELECT j.*, j.accounting_date::text, app.compute_journal_content_hash(j.id)::text AS content_hash, p.label AS period
    FROM journal_entries j JOIN fiscal_periods p ON p.organization_id=j.organization_id AND p.id=j.period_id
    WHERE j.organization_id=$1 AND j.id=$2`, [context.organizationId,id])).rows[0];
  if (!row) throw new Error("Selected journal is unavailable in this company");
  return row;
}
async function lines(client: PoolClient, context: TenantTransactionContext, definition: BookingDefinition, journalId: string | null, preview: readonly JournalLineInput[] = []): Promise<BookingLine[]> {
  const inputs = journalId ? (await client.query<JournalLineInput>(`SELECT account_combination_id AS "accountCombinationId", debit_functional::text AS "debitFunctional", credit_functional::text AS "creditFunctional",
    transaction_currency AS "transactionCurrency", debit_transaction::text AS "debitTransaction", credit_transaction::text AS "creditTransaction", fx_rate::text AS "fxRate",
    fx_rate_source AS "fxRateSource", fx_rate_effective_at::text AS "fxRateEffectiveAt", memo FROM journal_lines WHERE organization_id=$1 AND journal_entry_id=$2 ORDER BY line_number`, [context.organizationId,journalId])).rows : preview;
  if (!inputs.length) return [];
  const accounts = (await client.query<{id:string;code:string;display_name:string;class:string}>(`SELECT c.id,a.code,a.display_name,a.class FROM account_combinations c JOIN gl_accounts a ON a.organization_id=c.organization_id AND a.id=c.account_id
    WHERE c.organization_id=$1 AND c.ledger_id=$2 AND c.entity_id=$3 AND c.id=ANY($4::uuid[])`, [context.organizationId,definition.ledgerId,definition.legalEntityId,inputs.map((line)=>line.accountCombinationId)])).rows;
  const byId = new Map(accounts.map((account)=>[account.id,account]));
  return inputs.map((line)=> { const account = byId.get(line.accountCombinationId); if (!account) throw new Error("Selected account is outside the booking company and ledger");
    return {accountCombinationId:account.id, accountCode:account.code, accountName:account.display_name, accountClass:account.class,
      debitFunctional:line.debitFunctional,creditFunctional:line.creditFunctional,currency:line.transactionCurrency,debit:line.debitTransaction,credit:line.creditTransaction,
      fxRate:line.fxRate,fxSource:line.fxRateSource,fxDate:line.fxRateEffectiveAt,memo:line.memo ?? ""}; });
}
async function partyName(client: PoolClient, context: TenantTransactionContext, partyAccountId: string) {
  const row = (await client.query<{id:string;display_name_ciphertext:string;display_name_key_version:number}>(`SELECT p.id,p.display_name_ciphertext,p.display_name_key_version FROM party_accounts a JOIN parties p ON p.organization_id=a.organization_id AND p.id=a.party_id WHERE a.organization_id=$1 AND a.id=$2`,[context.organizationId,partyAccountId])).rows[0];
  if (!row) throw new Error("Selected counterparty is unavailable");
  const key = await loadOrganizationKeyVersion(client,context.organizationId,row.display_name_key_version);
  try { return decryptField(parseEncryptedField(row.display_name_ciphertext),key.dek,{organizationId:context.organizationId,table:"parties",column:"display_name_ciphertext",recordId:row.id,keyVersion:row.display_name_key_version}); }
  finally { key.dek.fill(0); }
}
function approval(header: Header) { return { creator:header.created_by, approver:header.approved_by, postedBy:header.posted_by, approvalVersion:header.approval_version, contentHash:header.content_hash }; }
export async function captureEntry(client: PoolClient, context: TenantTransactionContext, definition: BookingDefinition, selected: BookingRecord): Promise<BookingEntry> {
  await assertPermission(client,context,PERMISSIONS.readMcpLedger);
  if (selected.type === "JOURNAL") {
    const header = await journal(client,context,selected.id);
    if (header.ledger_id !== definition.ledgerId || header.legal_entity_id !== definition.legalEntityId || header.journal_type_key !== "ledger.manual") throw new Error("Select a manual journal in this company and ledger; select source documents for subledger journals");
    const differences = header.content_hash !== selected.expectedContentHash ? ["Journal content changed since selection"] : [];
    if ((header.approval_version ?? 0) !== selected.expectedVersion) differences.push("Journal approval version changed since selection");
    return {selected,id:header.id,sourceType:null,sourceNumber:header.journal_number ? `Journal ${header.journal_number}` : "Manual journal draft",version:header.approval_version ?? 0,contentHash:header.content_hash,
      kind:"JOURNAL",status:header.status,accountingDate:header.accounting_date,documentDate:header.accounting_date,period:header.period,description:header.description,party:null,
      currency:header.functional_currency,functionalCurrency:header.functional_currency,net:null,tax:null,gross:null,grossFunctional:null,outstanding:null,
      journalId:header.id,journalNumber:header.journal_number,linesArePosted:header.status === "POSTED",lines:await lines(client,context,definition,header.id),taxDetails:[],treatments:selected.note ? [`Reviewer note: ${selected.note}`] : [],attachments:[],approvalContext:approval(header),differences,
      heldReason:["REVERSED","DELETED"].includes(header.status) ? "Journal has been reversed or removed" : null};
  }
  const original = (await client.query<SourceDocumentRow>(`SELECT * FROM source_documents WHERE organization_id=$1 AND id=$2`,[context.organizationId,selected.id])).rows[0];
  if (!original) throw new Error("Selected source is unavailable in this company");
  await assertPermission(client,context,permissionForOwner(original.owner_module,"read"));
  const current = (await client.query<SourceDocumentRow>(`SELECT * FROM source_documents WHERE organization_id=$1 AND source_type=$2 AND source_number=$3 ORDER BY version DESC LIMIT 1`,[context.organizationId,original.source_type,original.source_number])).rows[0];
  const snapshot = subledgerSourceSnapshotSchema.parse(current.snapshot);
  if (snapshot.legalEntityId !== definition.legalEntityId || snapshot.ledgerId !== definition.ledgerId) throw new Error("Selected source belongs to another company or ledger");
  const differences: string[] = [];
  if (original.version !== selected.expectedVersion || original.content_hash !== selected.expectedContentHash) differences.push("Selected source version or content hash does not match");
  // Issuing appends a version without changing its immutable financial content.
  if (current.content_hash !== selected.expectedContentHash) differences.push(`Source content changed from version ${selected.expectedVersion} to ${current.version}`);
  if (current.id !== original.id && !(current.status === "POSTED" && current.content_hash === selected.expectedContentHash)) differences.push(`Source version changed from ${selected.expectedVersion} to ${current.version}`);
  const posted = (await client.query<{id:string}>(`SELECT id FROM journal_entries WHERE organization_id=$1 AND source_document_id=$2 AND status='POSTED' ORDER BY created_at LIMIT 1`,[context.organizationId,current.id])).rows[0];
  const header = posted ? await journal(client,context,posted.id) : null;
  const bill = "lines" in snapshot ? snapshot : null;
  let heldReason: string | null = current.status === "VOIDED" ? "Source has been voided" : current.status === "POSTED" && !header ? "Posted source has no active posted journal; review reversals" : null;
  let entryLines: BookingLine[] = [];
  if (header) entryLines = await lines(client,context,definition,header.id);
  else if (bill && current.status === "DRAFT") {
    try { entryLines = await lines(client,context,definition,null,buildIssueJournalLines(bill,current.id,new Map(bill.lines.map((line)=>[line.lineNumber,current.id])))); }
    catch { heldReason = "Draft accounting lines could not be prepared; review its account and tax setup"; }
  }
  if (bill && current.status === "DRAFT" && bill.lines.some((line)=>line.taxDecision.status === "MANUAL_REVIEW_REQUIRED" || line.taxDecision.sourceOverride?.state === "PENDING_REVIEW")) heldReason = "Source tax requires an authorized review before posting";
  const period = (await client.query<{label:string}>(`SELECT label FROM fiscal_periods WHERE organization_id=$1 AND id=$2`,[context.organizationId,snapshot.periodId])).rows[0]?.label ?? snapshot.accountingDate;
  const outstanding = bill && current.status === "POSTED" ? (await client.query<{amount:string}>(`SELECT balance.open_transaction_amount::text AS amount FROM open_item_balances balance JOIN subledger_events event ON event.organization_id=balance.organization_id AND event.id=balance.source_event_id WHERE balance.organization_id=$1 AND event.source_document_id=$2`,[context.organizationId,current.id])).rows[0]?.amount ?? null : null;
  const treatments: string[] = selected.note ? [`Reviewer note: ${selected.note}`] : [];
  if (bill && entryLines.some((line)=>line.accountClass === "ASSET" && line.accountCombinationId !== bill.controlAccountCombinationId && line.accountCombinationId !== bill.taxAccountCombinationId)) treatments.push("The selected asset accounts retain these costs on the balance sheet. Any depreciation or prepaid usage is recorded separately.");
  if (!bill && "settlementMethod" in snapshot) {
    if (snapshot.settlementMethod === "SHAREHOLDER_ADVANCE") treatments.push("The supplier is paid using personal funds; the company now owes the shareholder.");
    else if (snapshot.settlementMethod === "CORPORATE_CARD") treatments.push("The supplier balance is cleared and the amount is owed to the corporate card provider.");
    else if (snapshot.settlementMethod === "OTHER_NON_CASH") treatments.push("The supplier balance is transferred to the selected non-cash liability account; this is not a cash expense.");
    else if (snapshot.settlementMethod === "EMPLOYEE_REIMBURSEMENT") treatments.push("The supplier is paid using employee funds; the company now owes the employee.");
  }
  return {selected,id:current.id,sourceType:current.source_type,sourceNumber:current.source_number,version:current.version,contentHash:current.content_hash,kind:snapshot.kind,status:current.status,
    accountingDate:snapshot.accountingDate,documentDate:"documentDate" in snapshot ? snapshot.documentDate : snapshot.settlementDate,period,description:snapshot.description,party:await partyName(client,context,snapshot.partyAccountId),currency:snapshot.currency,functionalCurrency:snapshot.functionalCurrency,
    net:bill?.subtotal ?? null,tax:bill?.taxTotal ?? null,gross:bill?.grossTotal ?? null,grossFunctional:bill?.grossFunctional ?? null,outstanding,journalId:header?.id ?? null,journalNumber:header?.journal_number ?? null,linesArePosted:current.status === "POSTED" && header !== null,lines:entryLines,
    taxDetails:bill?.lines.map((line)=>({description:line.description,net:line.netAmount,tax:line.taxDecision.totalTax,treatment:line.taxDecision.components.map((component)=>`${component.treatment}: ${component.amount}`).join("; ") || line.taxDecision.status,
      rounding:line.taxDecision.sourceOverride?.adjustmentAmount ?? "0",evidence:line.taxDecision.sourceOverride?.evidenceReference ?? null,reason:line.taxDecision.sourceOverride?.reason ?? null})) ?? [],
    treatments,attachments:await loadDocumentEvidence(client,{organizationId:context.organizationId,ownerModule:current.owner_module,id:current.id,sourceNumber:current.source_number,version:current.version,evidence:bill?.evidence}),approvalContext:header ? approval(header) : null,differences,heldReason};
}
export async function captureBookingSnapshot(client: PoolClient, context: TenantTransactionContext, definition: BookingDefinition, phase: BookingSnapshot["phase"], reviewReportId: string | null, failures: Record<string,string> = {}): Promise<BookingSnapshot> {
  const company = (await client.query<{display_name:string;code:string}>(`SELECT e.display_name,e.code FROM legal_entities e JOIN ledgers l ON l.organization_id=e.organization_id AND l.legal_entity_id=e.id WHERE e.organization_id=$1 AND e.id=$2 AND l.id=$3`,[context.organizationId,definition.legalEntityId,definition.ledgerId])).rows[0];
  if (!company) throw new Error("Booking company and ledger are unavailable");
  const entries: BookingEntry[] = [];
  for (const selected of definition.records) { const entry = await captureEntry(client,context,definition,selected); if (phase === "REVIEW" && (entry.id !== selected.id || entry.version !== selected.expectedVersion)) entry.differences.push("Select the exact current source version for a new review"); if (failures[selected.id] && !entry.linesArePosted) entry.heldReason = failures[selected.id]; entries.push(entry); }
  for (const group of definition.clearingGroups) {
    const valid = (await client.query(`SELECT id FROM account_combinations WHERE organization_id=$1 AND entity_id=$2 AND ledger_id=$3 AND id=ANY($4::uuid[])`,[context.organizationId,definition.legalEntityId,definition.ledgerId,group.accountCombinationIds])).rows;
    if (new Set(valid.map((row)=>row.id)).size !== new Set(group.accountCombinationIds).size) throw new Error("Clearing accounts must belong to the booking company and ledger");
  }
  return {schemaVersion:1,title:definition.title,company:company.display_name,companyCode:company.code,legalEntityId:definition.legalEntityId,ledgerId:definition.ledgerId,generatedAt:new Date().toISOString(),generatedBy:context.actorId,requestId:context.requestId,reason:context.reason ?? definition.reason,phase,reviewReportId,entries,heldItems:definition.heldItems,summary:summarizeBookingEntries(entries,definition.heldItems,definition.clearingGroups)};
}
