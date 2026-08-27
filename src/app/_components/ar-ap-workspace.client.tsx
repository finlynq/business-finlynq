"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type {
  SubledgerAccountOptionDto,
  SubledgerEntityOptionDto,
  SubledgerPartyAccountOptionDto,
  SubledgerWorkspaceDocumentDto,
  SubledgerWorkspaceDto,
} from "@/modules/subledger/workspace";
import {
  displayExactMoney,
  exactAllocationTotal,
  isPositiveExactAmount,
} from "@/modules/subledger/client-money";
import { EmptyState, StatusPill } from "./ui";

type TaxCategory =
  | "STANDARD"
  | "ZERO_RATED"
  | "EXEMPT"
  | "RESALE"
  | "MARKETPLACE_COLLECTED"
  | "OUT_OF_SCOPE";

type DocumentLineDraft = Readonly<{
  key: string;
  description: string;
  accountCombinationId: string;
  netAmount: string;
  category: TaxCategory;
}>;

type BusinessDraft = Readonly<{
  editingVersion: number | null;
  sourceNumber: string;
  legalEntityId: string;
  partyAccountId: string;
  periodId: string;
  documentDate: string;
  accountingDate: string;
  dueOn: string;
  currency: string;
  fxRate: string;
  fxSource: string;
  fxEffectiveAt: string;
  taxAccountCombinationId: string;
  fxRoundingAccountCombinationId: string;
  description: string;
  recoverablePercent: string;
  evidenceReference: string;
  lines: readonly DocumentLineDraft[];
}>;

type SettlementDraft = Readonly<{
  sourceNumber: string;
  legalEntityId: string;
  partyAccountId: string;
  periodId: string;
  accountingDate: string;
  settlementDate: string;
  currency: string;
  fxRate: string;
  fxSource: string;
  fxEffectiveAt: string;
  bankAccountCombinationId: string;
  realizedFxGainAccountCombinationId: string;
  realizedFxLossAccountCombinationId: string;
  fxRoundingAccountCombinationId: string;
  description: string;
  allocations: Readonly<Record<string, string>>;
}>;

type VoidDraft = Readonly<{
  document: SubledgerWorkspaceDocumentDto;
  periodId: string;
  accountingDate: string;
  reason: string;
  description: string;
}>;

type ApiError = Readonly<{ error?: string }>;

function randomKey(prefix: string): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function mutationTimestamp(date: string): string {
  return new Date(`${date}T12:00:00.000Z`).toISOString();
}

function matchingPeriod(entity: SubledgerEntityOptionDto | undefined, date: string): string {
  return entity?.periods.find((period) => period.startsOn <= date && period.endsOn >= date)?.id
    ?? entity?.periods[0]?.id
    ?? "";
}

function preferredAccount(
  accounts: readonly SubledgerAccountOptionDto[],
  code: string,
): string {
  return accounts.find((account) => account.code === code)?.combinationId
    ?? accounts[0]?.combinationId
    ?? "";
}

function currentEntity(
  workspace: SubledgerWorkspaceDto,
  legalEntityId: string,
): SubledgerEntityOptionDto | undefined {
  return workspace.entities.find((entity) => entity.id === legalEntityId);
}

function currentParty(
  entity: SubledgerEntityOptionDto | undefined,
  partyAccountId: string,
): SubledgerPartyAccountOptionDto | undefined {
  return entity?.partyAccounts.find((party) => party.id === partyAccountId);
}

function defaultDocumentDraft(
  workspace: SubledgerWorkspaceDto,
  document?: SubledgerWorkspaceDocumentDto,
): BusinessDraft {
  if (document && (document.snapshot.kind === "SALES_INVOICE" || document.snapshot.kind === "SUPPLIER_BILL")) {
    const snapshot = document.snapshot;
    return {
      editingVersion: document.version,
      sourceNumber: snapshot.sourceNumber,
      legalEntityId: snapshot.legalEntityId,
      partyAccountId: snapshot.partyAccountId,
      periodId: snapshot.periodId,
      documentDate: snapshot.documentDate,
      accountingDate: snapshot.accountingDate,
      dueOn: snapshot.dueOn,
      currency: snapshot.currency,
      fxRate: snapshot.fx.rate,
      fxSource: snapshot.fx.source,
      fxEffectiveAt: snapshot.fx.effectiveAt,
      taxAccountCombinationId: snapshot.taxAccountCombinationId ?? "",
      fxRoundingAccountCombinationId: snapshot.fxRoundingAccountCombinationId ?? "",
      description: snapshot.description,
      recoverablePercent: snapshot.lines[0]?.tax.recoverablePercent ?? "100",
      evidenceReference: snapshot.lines[0]?.tax.evidenceReference ?? "",
      lines: snapshot.lines.map((line) => ({
        key: line.lineNumber.toString(),
        description: line.description,
        accountCombinationId: line.accountCombinationId,
        netAmount: line.netAmount,
        category: line.tax.category,
      })),
    };
  }

  const entity = workspace.entities.find((candidate) =>
    candidate.periods.length > 0 && candidate.partyAccounts.length > 0 && candidate.lineAccounts.length > 0)
    ?? workspace.entities[0];
  const party = entity?.partyAccounts[0];
  const documentDate = entity?.periods.some((period) =>
    period.startsOn <= workspace.currentDate && period.endsOn >= workspace.currentDate)
    ? workspace.currentDate
    : entity?.periods[0]?.startsOn ?? workspace.currentDate;
  const currency = party?.transactionCurrency ?? entity?.functionalCurrency ?? "USD";
  const taxCode = workspace.ownerModule === "receivables"
    ? "2200"
    : entity?.countryCode === "CA" ? "1500" : "6100";
  return {
    editingVersion: null,
    sourceNumber: "",
    legalEntityId: entity?.id ?? "",
    partyAccountId: party?.id ?? "",
    periodId: matchingPeriod(entity, documentDate),
    documentDate,
    accountingDate: documentDate,
    dueOn: addDays(documentDate, 30),
    currency,
    fxRate: currency === entity?.functionalCurrency ? "1" : "",
    fxSource: "USER_ENTERED",
    fxEffectiveAt: mutationTimestamp(documentDate),
    taxAccountCombinationId: preferredAccount(entity?.taxAccounts ?? [], taxCode),
    fxRoundingAccountCombinationId: preferredAccount(entity?.roundingAccounts ?? [], "7190"),
    description: "",
    recoverablePercent: workspace.ownerModule === "payables" ? "100" : "",
    evidenceReference: "",
    lines: [{
      key: randomKey("line"),
      description: "",
      accountCombinationId: preferredAccount(
        entity?.lineAccounts ?? [],
        workspace.ownerModule === "receivables" ? "4100" : "6100",
      ),
      netAmount: "",
      category: "STANDARD",
    }],
  };
}

function defaultSettlementDraft(
  workspace: SubledgerWorkspaceDto,
  requestedPartyAccountId?: string,
): SettlementDraft {
  const requestedEntity = requestedPartyAccountId
    ? workspace.entities.find((entity) => entity.partyAccounts.some((party) => party.id === requestedPartyAccountId))
    : undefined;
  const entity = requestedEntity
    ?? workspace.entities.find((candidate) => candidate.partyAccounts.some((party) =>
      workspace.openItems.some((item) => item.partyAccountId === party.id)))
    ?? workspace.entities[0];
  const party = entity?.partyAccounts.find((candidate) => candidate.id === requestedPartyAccountId)
    ?? entity?.partyAccounts.find((candidate) =>
      workspace.openItems.some((item) => item.partyAccountId === candidate.id))
    ?? entity?.partyAccounts[0];
  const item = workspace.openItems.find((candidate) => candidate.partyAccountId === party?.id);
  const date = entity?.periods.some((period) =>
    period.startsOn <= workspace.currentDate && period.endsOn >= workspace.currentDate)
    ? workspace.currentDate
    : entity?.periods[0]?.startsOn ?? workspace.currentDate;
  const currency = party?.transactionCurrency ?? item?.currency ?? entity?.functionalCurrency ?? "USD";
  return {
    sourceNumber: "",
    legalEntityId: entity?.id ?? "",
    partyAccountId: party?.id ?? "",
    periodId: matchingPeriod(entity, date),
    accountingDate: date,
    settlementDate: date,
    currency,
    fxRate: currency === entity?.functionalCurrency ? "1" : "",
    fxSource: "USER_ENTERED",
    fxEffectiveAt: mutationTimestamp(date),
    bankAccountCombinationId: preferredAccount(entity?.bankAccounts ?? [], "1000"),
    realizedFxGainAccountCombinationId: preferredAccount(entity?.fxGainAccounts ?? [], "4900"),
    realizedFxLossAccountCombinationId: preferredAccount(entity?.fxLossAccounts ?? [], "7100"),
    fxRoundingAccountCombinationId: preferredAccount(entity?.roundingAccounts ?? [], "7190"),
    description: "",
    allocations: {},
  };
}

function apiBase(workspace: SubledgerWorkspaceDto): Readonly<{
  business: string;
  settlement: string;
}> {
  return workspace.ownerModule === "receivables"
    ? { business: "/api/receivables/invoices", settlement: "/api/receivables/receipts" }
    : { business: "/api/payables/bills", settlement: "/api/payables/payments" };
}

async function mutate(url: string, method: "POST" | "PATCH", body: unknown): Promise<void> {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as ApiError;
  if (!response.ok) throw new Error(result.error ?? "The accounting operation could not be completed");
}

function focusComposer(): void {
  requestAnimationFrame(() => document.getElementById("subledger-composer")?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  }));
}

function AccountSelect({
  label,
  value,
  accounts,
  onChange,
  required = true,
}: Readonly<{
  label: string;
  value: string;
  accounts: readonly SubledgerAccountOptionDto[];
  onChange: (value: string) => void;
  required?: boolean;
}>) {
  return (
    <label className="full-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} required={required}>
        {!required && <option value="">None</option>}
        {accounts.map((account) => (
          <option key={account.combinationId} value={account.combinationId}>
            {account.code} · {account.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ArApWorkspace({ workspace }: Readonly<{ workspace: SubledgerWorkspaceDto }>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState<"DOCUMENT" | "SETTLEMENT" | null>(null);
  const [documentDraft, setDocumentDraft] = useState<BusinessDraft>(() => defaultDocumentDraft(workspace));
  const [settlementDraft, setSettlementDraft] = useState<SettlementDraft>(() => defaultSettlementDraft(workspace));
  const [voidDraft, setVoidDraft] = useState<VoidDraft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = apiBase(workspace);

  const documentEntity = currentEntity(workspace, documentDraft.legalEntityId);
  const documentParty = currentParty(documentEntity, documentDraft.partyAccountId);
  const settlementEntity = currentEntity(workspace, settlementDraft.legalEntityId);
  const settlementParty = currentParty(settlementEntity, settlementDraft.partyAccountId);
  const settlementItems = workspace.openItems.filter((item) =>
    item.partyAccountId === settlementDraft.partyAccountId && item.currency === settlementDraft.currency);
  const settlementTotal = useMemo(
    () => exactAllocationTotal(settlementDraft.allocations, settlementDraft.currency),
    [settlementDraft.allocations, settlementDraft.currency],
  );

  const businessLabel = workspace.ownerModule === "receivables" ? "invoice" : "bill";
  const settlementLabel = workspace.ownerModule === "receivables" ? "receipt" : "payment";
  const counterpartyLabel = workspace.ownerModule === "receivables" ? "customer" : "supplier";

  function finish(messageText: string): void {
    setError(null);
    setMessage(messageText);
    setComposer(null);
    setVoidDraft(null);
    startTransition(() => router.refresh());
  }

  function openDocument(document?: SubledgerWorkspaceDocumentDto): void {
    setDocumentDraft(defaultDocumentDraft(workspace, document));
    setComposer("DOCUMENT");
    setVoidDraft(null);
    setError(null);
    setMessage(null);
    focusComposer();
  }

  function openSettlement(partyAccountId?: string): void {
    setSettlementDraft(defaultSettlementDraft(workspace, partyAccountId));
    setComposer("SETTLEMENT");
    setVoidDraft(null);
    setError(null);
    setMessage(null);
    focusComposer();
  }

  function chooseDocumentEntity(legalEntityId: string): void {
    const entity = currentEntity(workspace, legalEntityId);
    const party = entity?.partyAccounts[0];
    const date = entity?.periods.some((period) =>
      period.startsOn <= workspace.currentDate && period.endsOn >= workspace.currentDate)
      ? workspace.currentDate
      : entity?.periods[0]?.startsOn ?? workspace.currentDate;
    const currency = party?.transactionCurrency ?? entity?.functionalCurrency ?? "USD";
    const taxCode = workspace.ownerModule === "receivables"
      ? "2200"
      : entity?.countryCode === "CA" ? "1500" : "6100";
    setDocumentDraft((draft) => ({
      ...draft,
      legalEntityId,
      partyAccountId: party?.id ?? "",
      periodId: matchingPeriod(entity, date),
      documentDate: date,
      accountingDate: date,
      dueOn: addDays(date, 30),
      currency,
      fxRate: currency === entity?.functionalCurrency ? "1" : "",
      fxEffectiveAt: mutationTimestamp(date),
      taxAccountCombinationId: preferredAccount(entity?.taxAccounts ?? [], taxCode),
      fxRoundingAccountCombinationId: preferredAccount(entity?.roundingAccounts ?? [], "7190"),
      lines: draft.lines.map((line) => ({
        ...line,
        accountCombinationId: preferredAccount(
          entity?.lineAccounts ?? [],
          workspace.ownerModule === "receivables" ? "4100" : "6100",
        ),
      })),
    }));
  }

  function chooseDocumentParty(partyAccountId: string): void {
    const party = currentParty(documentEntity, partyAccountId);
    const currency = party?.transactionCurrency ?? documentDraft.currency;
    setDocumentDraft((draft) => ({
      ...draft,
      partyAccountId,
      currency,
      fxRate: currency === documentEntity?.functionalCurrency ? "1" : draft.fxRate,
    }));
  }

  function updateLine(key: string, patch: Partial<DocumentLineDraft>): void {
    setDocumentDraft((draft) => ({
      ...draft,
      lines: draft.lines.map((line) => line.key === key ? { ...line, ...patch } : line),
    }));
  }

  async function saveDocument(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!documentEntity || !documentParty) return setError(`Select an active ${counterpartyLabel} account`);
    setError(null);
    setMessage(null);
    setBusy(true);
    const tax = documentEntity.tax;
    const payload = {
      kind: workspace.businessKind,
      sourceNumber: documentDraft.sourceNumber,
      ledgerId: documentEntity.ledgerId,
      legalEntityId: documentEntity.id,
      partyAccountId: documentParty.id,
      controlAccountCombinationId: documentParty.controlAccountCombinationId,
      ...(documentDraft.taxAccountCombinationId
        ? { taxAccountCombinationId: documentDraft.taxAccountCombinationId }
        : {}),
      ...(documentDraft.fxRoundingAccountCombinationId
        ? { fxRoundingAccountCombinationId: documentDraft.fxRoundingAccountCombinationId }
        : {}),
      documentDate: documentDraft.documentDate,
      accountingDate: documentDraft.accountingDate,
      periodId: documentDraft.periodId,
      dueOn: documentDraft.dueOn,
      currency: documentDraft.currency,
      fx: {
        rate: documentDraft.fxRate,
        source: documentDraft.fxSource,
        effectiveAt: documentDraft.fxEffectiveAt,
        quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT" as const,
      },
      description: documentDraft.description,
      lines: documentDraft.lines.map((line) => ({
        description: line.description,
        accountCombinationId: line.accountCombinationId,
        netAmount: line.netAmount,
        tax: {
          packKey: tax.packKey,
          category: line.category,
          destinationCountry: tax.destinationCountry,
          destinationRegion: tax.destinationRegion,
          ...(tax.destinationCity ? { destinationCity: tax.destinationCity } : {}),
          ...(tax.locationCode ? { locationCode: tax.locationCode } : {}),
          ...(tax.registrationReference ? { registrationId: tax.registrationReference } : {}),
          ...(documentDraft.evidenceReference
            ? { evidenceReference: documentDraft.evidenceReference }
            : {}),
          ...(workspace.ownerModule === "payables" && documentDraft.recoverablePercent
            ? { recoverablePercent: documentDraft.recoverablePercent }
            : {}),
        },
      })),
      ...(documentDraft.editingVersion ? { expectedVersion: documentDraft.editingVersion } : {}),
      idempotencyKey: globalThis.crypto.randomUUID(),
    };
    try {
      await mutate(base.business, documentDraft.editingVersion ? "PATCH" : "POST", payload);
      finish(`${businessLabel[0]?.toUpperCase()}${businessLabel.slice(1)} draft ${documentDraft.editingVersion ? "updated" : "created"}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to save the ${businessLabel}`);
    } finally {
      setBusy(false);
    }
  }

  async function issueDocument(document: SubledgerWorkspaceDocumentDto): Promise<void> {
    if (document.snapshot.kind !== workspace.businessKind) return;
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      await mutate(`${base.business}/issue`, "POST", {
        kind: workspace.businessKind,
        sourceNumber: document.sourceNumber,
        expectedVersion: document.version,
        idempotencyKey: globalThis.crypto.randomUUID(),
      });
      finish(`${businessLabel[0]?.toUpperCase()}${businessLabel.slice(1)} ${document.sourceNumber} issued and posted.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to issue the ${businessLabel}`);
    } finally {
      setBusy(false);
    }
  }

  function chooseSettlementEntity(legalEntityId: string): void {
    const entity = currentEntity(workspace, legalEntityId);
    const party = entity?.partyAccounts.find((candidate) =>
      workspace.openItems.some((item) => item.partyAccountId === candidate.id))
      ?? entity?.partyAccounts[0];
    const item = workspace.openItems.find((candidate) => candidate.partyAccountId === party?.id);
    const date = entity?.periods.some((period) =>
      period.startsOn <= workspace.currentDate && period.endsOn >= workspace.currentDate)
      ? workspace.currentDate
      : entity?.periods[0]?.startsOn ?? workspace.currentDate;
    const currency = party?.transactionCurrency ?? item?.currency ?? entity?.functionalCurrency ?? "USD";
    setSettlementDraft((draft) => ({
      ...draft,
      legalEntityId,
      partyAccountId: party?.id ?? "",
      periodId: matchingPeriod(entity, date),
      accountingDate: date,
      settlementDate: date,
      currency,
      fxRate: currency === entity?.functionalCurrency ? "1" : "",
      fxEffectiveAt: mutationTimestamp(date),
      bankAccountCombinationId: preferredAccount(entity?.bankAccounts ?? [], "1000"),
      realizedFxGainAccountCombinationId: preferredAccount(entity?.fxGainAccounts ?? [], "4900"),
      realizedFxLossAccountCombinationId: preferredAccount(entity?.fxLossAccounts ?? [], "7100"),
      fxRoundingAccountCombinationId: preferredAccount(entity?.roundingAccounts ?? [], "7190"),
      allocations: {},
    }));
  }

  function chooseSettlementParty(partyAccountId: string): void {
    const party = currentParty(settlementEntity, partyAccountId);
    const item = workspace.openItems.find((candidate) => candidate.partyAccountId === partyAccountId);
    const currency = party?.transactionCurrency ?? item?.currency ?? settlementEntity?.functionalCurrency ?? "USD";
    setSettlementDraft((draft) => ({
      ...draft,
      partyAccountId,
      currency,
      fxRate: currency === settlementEntity?.functionalCurrency ? "1" : "",
      allocations: {},
    }));
  }

  async function saveSettlement(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!settlementEntity || !settlementParty) return setError(`Select an active ${counterpartyLabel} account`);
    const allocations = Object.entries(settlementDraft.allocations)
      .filter(([, amount]) => isPositiveExactAmount(amount))
      .map(([openItemId, transactionAmount]) => ({ openItemId, transactionAmount }));
    if (allocations.length === 0) return setError("Enter at least one allocation amount");
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      await mutate(base.settlement, "POST", {
        kind: workspace.settlementKind,
        sourceNumber: settlementDraft.sourceNumber,
        ledgerId: settlementEntity.ledgerId,
        legalEntityId: settlementEntity.id,
        partyAccountId: settlementParty.id,
        controlAccountCombinationId: settlementParty.controlAccountCombinationId,
        periodId: settlementDraft.periodId,
        accountingDate: settlementDraft.accountingDate,
        settlementDate: settlementDraft.settlementDate,
        currency: settlementDraft.currency,
        amount: settlementTotal,
        fx: {
          rate: settlementDraft.fxRate,
          source: settlementDraft.fxSource,
          effectiveAt: settlementDraft.fxEffectiveAt,
          quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
        },
        bankAccountCombinationId: settlementDraft.bankAccountCombinationId,
        realizedFxGainAccountCombinationId: settlementDraft.realizedFxGainAccountCombinationId,
        realizedFxLossAccountCombinationId: settlementDraft.realizedFxLossAccountCombinationId,
        ...(settlementDraft.fxRoundingAccountCombinationId
          ? { fxRoundingAccountCombinationId: settlementDraft.fxRoundingAccountCombinationId }
          : {}),
        description: settlementDraft.description,
        allocations,
        idempotencyKey: globalThis.crypto.randomUUID(),
      });
      finish(`${settlementLabel[0]?.toUpperCase()}${settlementLabel.slice(1)} recorded, allocated, and posted.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to record the ${settlementLabel}`);
    } finally {
      setBusy(false);
    }
  }

  function prepareVoid(document: SubledgerWorkspaceDocumentDto): void {
    const entity = currentEntity(workspace, document.snapshot.legalEntityId);
    const date = entity?.periods.some((period) =>
      period.startsOn <= workspace.currentDate && period.endsOn >= workspace.currentDate)
      ? workspace.currentDate
      : entity?.periods[0]?.startsOn ?? workspace.currentDate;
    setVoidDraft({
      document,
      periodId: matchingPeriod(entity, date),
      accountingDate: date,
      reason: "",
      description: `Void ${document.sourceNumber}`,
    });
    setComposer(null);
    setError(null);
    setMessage(null);
    setBusy(false);
    focusComposer();
  }

  async function submitVoid(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!voidDraft) return;
    const business = voidDraft.document.snapshot.kind === "SALES_INVOICE"
      || voidDraft.document.snapshot.kind === "SUPPLIER_BILL";
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      await mutate(`${business ? base.business : base.settlement}/void`, "POST", {
        kind: voidDraft.document.snapshot.kind,
        sourceNumber: voidDraft.document.sourceNumber,
        expectedVersion: voidDraft.document.version,
        periodId: voidDraft.periodId,
        accountingDate: voidDraft.accountingDate,
        reason: voidDraft.reason,
        description: voidDraft.description,
        idempotencyKey: globalThis.crypto.randomUUID(),
      });
      finish(`${voidDraft.document.sourceNumber} voided with an immutable reversing entry.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to void the transaction");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {(workspace.canManage || workspace.canSettle) && (
        <div className="subledger-toolbar" aria-label={`${businessLabel} actions`}>
          {workspace.canManage && (
            <button className="primary-button" type="button" onClick={() => openDocument()} disabled={busy || pending}>
              ＋ New {businessLabel}
            </button>
          )}
          {workspace.canSettle && (
            <button className="secondary-button" type="button" onClick={() => openSettlement()} disabled={busy || pending || !workspace.openItems.length}>
              Record {settlementLabel}
            </button>
          )}
          {!workspace.openItems.length && workspace.canSettle && (
            <span className="subtle-label">Issue a {businessLabel} before recording a {settlementLabel}.</span>
          )}
        </div>
      )}

      <div className="subledger-feedback" aria-live="polite" aria-atomic="true">
        {pending && <p className="validation-message validation-success">Refreshing the tenant register…</p>}
        {message && <p className="validation-message validation-success">{message}</p>}
        {error && <p className="validation-message validation-error">{error}</p>}
      </div>

      {composer === "DOCUMENT" && documentEntity && (
        <section className="panel form-panel" id="subledger-composer" aria-labelledby="document-composer-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{documentDraft.editingVersion ? `Draft version ${documentDraft.editingVersion}` : "New source document"}</p>
              <h2 id="document-composer-title">{documentDraft.editingVersion ? "Edit" : "Create"} {businessLabel}</h2>
            </div>
            <button className="secondary-button compact-button" type="button" onClick={() => setComposer(null)}>Cancel</button>
          </div>
          <form className="journal-form subledger-form" onSubmit={saveDocument}>
            <div className="form-grid form-grid-three">
              <label className="full-field">
                <span>{businessLabel[0]?.toUpperCase()}{businessLabel.slice(1)} number</span>
                <input value={documentDraft.sourceNumber} onChange={(event) => setDocumentDraft((draft) => ({ ...draft, sourceNumber: event.target.value.toUpperCase() }))} pattern="[A-Z0-9](?:[A-Z0-9._]|-|/)*" maxLength={50} disabled={documentDraft.editingVersion !== null} required />
              </label>
              <label className="full-field">
                <span>Legal entity</span>
                <select value={documentDraft.legalEntityId} onChange={(event) => chooseDocumentEntity(event.target.value)} disabled={documentDraft.editingVersion !== null} required>
                  {workspace.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.code} · {entity.displayName}</option>)}
                </select>
              </label>
              <label className="full-field">
                <span>{counterpartyLabel[0]?.toUpperCase()}{counterpartyLabel.slice(1)} account</span>
                <select value={documentDraft.partyAccountId} onChange={(event) => chooseDocumentParty(event.target.value)} disabled={documentDraft.editingVersion !== null} required>
                  {documentEntity.partyAccounts.map((party) => <option key={party.id} value={party.id}>{party.accountNumber} · {party.partyName}</option>)}
                </select>
              </label>
              <label className="full-field">
                <span>Document date</span>
                <input type="date" value={documentDraft.documentDate} onChange={(event) => setDocumentDraft((draft) => ({ ...draft, documentDate: event.target.value, dueOn: addDays(event.target.value, 30), fxEffectiveAt: mutationTimestamp(event.target.value) }))} required />
              </label>
              <label className="full-field">
                <span>Accounting period</span>
                <select value={documentDraft.periodId} onChange={(event) => setDocumentDraft((draft) => ({ ...draft, periodId: event.target.value }))} required>
                  {documentEntity.periods.map((period) => <option key={period.id} value={period.id}>{period.label} · {period.startsOn}–{period.endsOn}</option>)}
                </select>
              </label>
              <label className="full-field">
                <span>Accounting date</span>
                <input type="date" value={documentDraft.accountingDate} onChange={(event) => setDocumentDraft((draft) => ({ ...draft, accountingDate: event.target.value }))} required />
              </label>
              <label className="full-field">
                <span>Due date</span>
                <input type="date" min={documentDraft.documentDate} value={documentDraft.dueOn} onChange={(event) => setDocumentDraft((draft) => ({ ...draft, dueOn: event.target.value }))} required />
              </label>
              <label className="full-field">
                <span>Transaction currency</span>
                <select value={documentDraft.currency} onChange={(event) => setDocumentDraft((draft) => ({ ...draft, currency: event.target.value, fxRate: event.target.value === documentEntity.functionalCurrency ? "1" : "" }))} disabled={Boolean(documentParty?.transactionCurrency)} required>
                  {workspace.currencies.map((currency) => <option key={currency.code} value={currency.code}>{currency.code}</option>)}
                </select>
              </label>
              <label className="full-field">
                <span>FX rate</span>
                <input inputMode="decimal" value={documentDraft.fxRate} onChange={(event) => setDocumentDraft((draft) => ({ ...draft, fxRate: event.target.value }))} disabled={documentDraft.currency === documentEntity.functionalCurrency} required />
                <small>{documentEntity.functionalCurrency} per {documentDraft.currency}; immutable when saved.</small>
              </label>
              <label className="full-field">
                <span>FX source</span>
                <input value={documentDraft.fxSource} onChange={(event) => setDocumentDraft((draft) => ({ ...draft, fxSource: event.target.value }))} maxLength={100} required />
              </label>
              <label className="full-field">
                <span>FX effective time</span>
                <input value={documentDraft.fxEffectiveAt} readOnly />
                <small>UTC snapshot tied to the selected document date.</small>
              </label>
            </div>

            <label className="full-field">
              <span>Description</span>
              <input value={documentDraft.description} onChange={(event) => setDocumentDraft((draft) => ({ ...draft, description: event.target.value }))} maxLength={500} required />
            </label>

            <div className="journal-lines-heading">
              <div><p className="eyebrow">Service lines</p><h2>Amounts and tax facts</h2></div>
              <button className="secondary-button compact-button" type="button" onClick={() => setDocumentDraft((draft) => ({
                ...draft,
                lines: [...draft.lines, {
                  key: randomKey("line"),
                  description: "",
                  accountCombinationId: draft.lines[0]?.accountCombinationId ?? documentEntity.lineAccounts[0]?.combinationId ?? "",
                  netAmount: "",
                  category: "STANDARD",
                }],
              }))}>＋ Add line</button>
            </div>
            <div className="subledger-lines">
              {documentDraft.lines.map((line, index) => (
                <fieldset className="subledger-line" key={line.key}>
                  <legend>Line {index + 1}</legend>
                  <label className="full-field subledger-description-field">
                    <span>Description</span>
                    <input value={line.description} onChange={(event) => updateLine(line.key, { description: event.target.value })} maxLength={500} required />
                  </label>
                  <AccountSelect label={workspace.ownerModule === "receivables" ? "Revenue account" : "Expense / asset account"} value={line.accountCombinationId} accounts={documentEntity.lineAccounts} onChange={(value) => updateLine(line.key, { accountCombinationId: value })} />
                  <label className="full-field">
                    <span>Net amount</span>
                    <input inputMode="decimal" value={line.netAmount} onChange={(event) => updateLine(line.key, { netAmount: event.target.value })} placeholder="0.00" required />
                  </label>
                  <label className="full-field">
                    <span>Tax treatment</span>
                    <select value={line.category} onChange={(event) => updateLine(line.key, { category: event.target.value as TaxCategory })}>
                      <option value="STANDARD">Standard</option>
                      {documentEntity.countryCode === "CA" ? <><option value="ZERO_RATED">Zero-rated</option><option value="EXEMPT">Exempt</option></> : <><option value="RESALE">Resale</option><option value="MARKETPLACE_COLLECTED">Marketplace collected</option></>}
                      <option value="OUT_OF_SCOPE">Out of scope</option>
                    </select>
                  </label>
                  <button className="icon-button remove-line" type="button" aria-label={`Remove line ${index + 1}`} onClick={() => setDocumentDraft((draft) => ({ ...draft, lines: draft.lines.filter((candidate) => candidate.key !== line.key) }))} disabled={documentDraft.lines.length === 1}>×</button>
                </fieldset>
              ))}
            </div>

            <div className="form-grid form-grid-three">
              <AccountSelect label={workspace.ownerModule === "receivables" ? "Tax payable account" : "Recoverable, expense, or use-tax payable account"} value={documentDraft.taxAccountCombinationId} accounts={documentEntity.taxAccounts} onChange={(value) => setDocumentDraft((draft) => ({ ...draft, taxAccountCombinationId: value }))} />
              <AccountSelect label="FX rounding account" value={documentDraft.fxRoundingAccountCombinationId} accounts={documentEntity.roundingAccounts} onChange={(value) => setDocumentDraft((draft) => ({ ...draft, fxRoundingAccountCombinationId: value }))} required={false} />
              {workspace.ownerModule === "payables" ? (
                <label className="full-field">
                  <span>Recoverable tax %</span>
                  <input inputMode="decimal" value={documentDraft.recoverablePercent} onChange={(event) => setDocumentDraft((draft) => ({ ...draft, recoverablePercent: event.target.value }))} />
                </label>
              ) : (
                <label className="full-field">
                  <span>Tax jurisdiction</span>
                  <input value={`${documentEntity.tax.destinationCountry}-${documentEntity.tax.destinationRegion} · ${documentEntity.tax.packKey}`} readOnly />
                </label>
              )}
            </div>
            {documentDraft.lines.some((line) => line.category === "RESALE" || line.category === "MARKETPLACE_COLLECTED") && (
              <label className="full-field">
                <span>Tax evidence reference</span>
                <input value={documentDraft.evidenceReference} onChange={(event) => setDocumentDraft((draft) => ({ ...draft, evidenceReference: event.target.value }))} maxLength={200} required />
              </label>
            )}
            <p className="form-footnote">
              Tax pack {documentEntity.tax.packKey} is snapshotted line by line. FX source and effective time are stored immutably with every version.
            </p>
            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={busy || pending}>Save draft</button>
              <button className="secondary-button" type="button" onClick={() => setComposer(null)}>Cancel</button>
            </div>
          </form>
        </section>
      )}

      {composer === "SETTLEMENT" && settlementEntity && (
        <section className="panel form-panel" id="subledger-composer" aria-labelledby="settlement-composer-title">
          <div className="panel-heading">
            <div><p className="eyebrow">Cash application</p><h2 id="settlement-composer-title">Record {settlementLabel}</h2></div>
            <button className="secondary-button compact-button" type="button" onClick={() => setComposer(null)}>Cancel</button>
          </div>
          <form className="journal-form subledger-form" onSubmit={saveSettlement}>
            <div className="form-grid form-grid-three">
              <label className="full-field">
                <span>{settlementLabel[0]?.toUpperCase()}{settlementLabel.slice(1)} number</span>
                <input value={settlementDraft.sourceNumber} onChange={(event) => setSettlementDraft((draft) => ({ ...draft, sourceNumber: event.target.value.toUpperCase() }))} pattern="[A-Z0-9](?:[A-Z0-9._]|-|/)*" maxLength={50} required />
              </label>
              <label className="full-field">
                <span>Legal entity</span>
                <select value={settlementDraft.legalEntityId} onChange={(event) => chooseSettlementEntity(event.target.value)} required>
                  {workspace.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.code} · {entity.displayName}</option>)}
                </select>
              </label>
              <label className="full-field">
                <span>{counterpartyLabel[0]?.toUpperCase()}{counterpartyLabel.slice(1)} account</span>
                <select value={settlementDraft.partyAccountId} onChange={(event) => chooseSettlementParty(event.target.value)} required>
                  {settlementEntity.partyAccounts.map((party) => <option key={party.id} value={party.id}>{party.accountNumber} · {party.partyName}</option>)}
                </select>
              </label>
              <label className="full-field">
                <span>Accounting period</span>
                <select value={settlementDraft.periodId} onChange={(event) => setSettlementDraft((draft) => ({ ...draft, periodId: event.target.value }))} required>
                  {settlementEntity.periods.map((period) => <option key={period.id} value={period.id}>{period.label}</option>)}
                </select>
              </label>
              <label className="full-field"><span>Accounting date</span><input type="date" value={settlementDraft.accountingDate} onChange={(event) => setSettlementDraft((draft) => ({ ...draft, accountingDate: event.target.value }))} required /></label>
              <label className="full-field"><span>Settlement date</span><input type="date" value={settlementDraft.settlementDate} onChange={(event) => setSettlementDraft((draft) => ({ ...draft, settlementDate: event.target.value, fxEffectiveAt: mutationTimestamp(event.target.value) }))} required /></label>
              <label className="full-field">
                <span>Currency</span>
                <select value={settlementDraft.currency} onChange={(event) => setSettlementDraft((draft) => ({ ...draft, currency: event.target.value, fxRate: event.target.value === settlementEntity.functionalCurrency ? "1" : "", allocations: {} }))} disabled={Boolean(settlementParty?.transactionCurrency)} required>
                  {workspace.currencies.map((currency) => <option key={currency.code} value={currency.code}>{currency.code}</option>)}
                </select>
              </label>
              <label className="full-field">
                <span>FX rate</span>
                <input inputMode="decimal" value={settlementDraft.fxRate} onChange={(event) => setSettlementDraft((draft) => ({ ...draft, fxRate: event.target.value }))} disabled={settlementDraft.currency === settlementEntity.functionalCurrency} required />
                <small>{settlementEntity.functionalCurrency} per {settlementDraft.currency}.</small>
              </label>
              <label className="full-field"><span>FX source</span><input value={settlementDraft.fxSource} onChange={(event) => setSettlementDraft((draft) => ({ ...draft, fxSource: event.target.value }))} maxLength={100} required /></label>
              <label className="full-field"><span>FX effective time</span><input value={settlementDraft.fxEffectiveAt} readOnly /><small>UTC snapshot tied to the settlement date.</small></label>
              <label className="full-field"><span>Total allocated</span><input value={displayExactMoney(settlementDraft.currency, settlementTotal)} readOnly /></label>
            </div>
            <label className="full-field"><span>Description</span><input value={settlementDraft.description} onChange={(event) => setSettlementDraft((draft) => ({ ...draft, description: event.target.value }))} maxLength={500} required /></label>

            <div className="journal-lines-heading"><div><p className="eyebrow">Open items</p><h2>Exact allocations</h2></div></div>
            {settlementItems.length ? (
              <div className="table-scroll allocation-table" tabIndex={0}>
                <table>
                  <caption className="sr-only">Open items available for allocation</caption>
                  <thead><tr><th scope="col">Source</th><th scope="col">Due</th><th scope="col">Open</th><th scope="col">Allocate</th></tr></thead>
                  <tbody>{settlementItems.map((item) => (
                    <tr key={item.id}>
                      <td><strong>{item.sourceNumber}</strong><small>{item.status}</small></td>
                      <td>{item.dueOn ?? "No due date"}</td>
                      <td className="amount-cell">{displayExactMoney(item.currency, item.openAmount)}</td>
                      <td><label className="allocation-input"><span className="sr-only">Allocation for {item.sourceNumber}</span><input inputMode="decimal" placeholder="0.00" value={settlementDraft.allocations[item.id] ?? ""} onChange={(event) => setSettlementDraft((draft) => ({ ...draft, allocations: { ...draft.allocations, [item.id]: event.target.value } }))} /></label></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <EmptyState title="No matching open items">Choose a {counterpartyLabel} and currency with an issued open {businessLabel}.</EmptyState>}

            <details className="mapping-details">
              <summary>Accounting mappings</summary>
              <div className="form-grid form-grid-three">
                <AccountSelect label="Bank / cash account" value={settlementDraft.bankAccountCombinationId} accounts={settlementEntity.bankAccounts} onChange={(value) => setSettlementDraft((draft) => ({ ...draft, bankAccountCombinationId: value }))} />
                <AccountSelect label="Realized FX gain" value={settlementDraft.realizedFxGainAccountCombinationId} accounts={settlementEntity.fxGainAccounts} onChange={(value) => setSettlementDraft((draft) => ({ ...draft, realizedFxGainAccountCombinationId: value }))} />
                <AccountSelect label="Realized FX loss" value={settlementDraft.realizedFxLossAccountCombinationId} accounts={settlementEntity.fxLossAccounts} onChange={(value) => setSettlementDraft((draft) => ({ ...draft, realizedFxLossAccountCombinationId: value }))} />
                <AccountSelect label="FX rounding" value={settlementDraft.fxRoundingAccountCombinationId} accounts={settlementEntity.roundingAccounts} onChange={(value) => setSettlementDraft((draft) => ({ ...draft, fxRoundingAccountCombinationId: value }))} required={false} />
              </div>
            </details>
            <p className="form-footnote">The {settlementLabel} is fully allocated in one transaction. Any realized FX difference is posted automatically from the immutable invoice carrying rate.</p>
            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={busy || pending || !settlementItems.length || !isPositiveExactAmount(settlementTotal)}>Record and post {settlementLabel}</button>
              <button className="secondary-button" type="button" onClick={() => setComposer(null)}>Cancel</button>
            </div>
          </form>
        </section>
      )}

      {voidDraft && (() => {
        const entity = currentEntity(workspace, voidDraft.document.snapshot.legalEntityId);
        return entity ? (
          <section className="panel form-panel void-panel" id="subledger-composer" aria-labelledby="void-title">
            <div className="panel-heading"><div><p className="eyebrow">Append-only correction</p><h2 id="void-title">Void {voidDraft.document.sourceNumber}</h2></div><StatusPill status={voidDraft.document.status} /></div>
            <form className="journal-form" onSubmit={submitVoid}>
              <p className="currency-warning"><span aria-hidden="true">!</span><span>Voiding never deletes history. The system appends a VOIDED version, a reversing journal, and exact allocation reversals where applicable.</span></p>
              <div className="form-grid form-grid-three">
                <label className="full-field"><span>Reversal period</span><select value={voidDraft.periodId} onChange={(event) => setVoidDraft((draft) => draft ? { ...draft, periodId: event.target.value } : draft)} required>{entity.periods.map((period) => <option key={period.id} value={period.id}>{period.label}</option>)}</select></label>
                <label className="full-field"><span>Accounting date</span><input type="date" value={voidDraft.accountingDate} onChange={(event) => setVoidDraft((draft) => draft ? { ...draft, accountingDate: event.target.value } : draft)} required /></label>
                <label className="full-field"><span>Reversal description</span><input value={voidDraft.description} onChange={(event) => setVoidDraft((draft) => draft ? { ...draft, description: event.target.value } : draft)} maxLength={500} required /></label>
              </div>
              <label className="full-field"><span>Mandatory reason</span><textarea rows={3} minLength={5} maxLength={500} value={voidDraft.reason} onChange={(event) => setVoidDraft((draft) => draft ? { ...draft, reason: event.target.value } : draft)} required /></label>
              <div className="form-actions"><button className="primary-button danger-button" type="submit" disabled={busy || pending}>Void and reverse</button><button className="secondary-button" type="button" onClick={() => setVoidDraft(null)}>Cancel</button></div>
            </form>
          </section>
        ) : null;
      })()}

      {workspace.documents.length ? (
        <section className="record-grid subledger-record-grid" aria-label={`${businessLabel} and ${settlementLabel} register`}>
          {workspace.documents.map((document) => {
            const businessSnapshot = "grossTotal" in document.snapshot ? document.snapshot : null;
            const settlementSnapshot = "amount" in document.snapshot ? document.snapshot : null;
            const business = businessSnapshot !== null;
            const amount = businessSnapshot?.grossTotal ?? settlementSnapshot?.amount ?? "0";
            const documentDate = businessSnapshot?.documentDate ?? settlementSnapshot?.settlementDate ?? document.createdAt.slice(0, 10);
            const partiallySettled = document.openStatus === "PARTIALLY_SETTLED" || document.openStatus === "SETTLED";
            return (
              <article className="record-card subledger-record" id={`source-${document.id}`} key={document.id}>
                <div><span className="code-chip">{document.sourceNumber}</span><StatusPill status={document.status} /></div>
                <p className="subledger-kind">{document.snapshot.kind.replaceAll("_", " ")} · immutable version {document.version}</p>
                <h2>{document.partyName}</h2>
                <p>{document.entityCode} · {documentDate}</p>
                <strong className="record-amount">{displayExactMoney(document.snapshot.currency, amount)}</strong>
                <dl>
                  {business && <div><dt>Open balance</dt><dd>{document.openAmount === null ? "Not issued" : displayExactMoney(document.snapshot.currency, document.openAmount)} {document.openStatus && <StatusPill status={document.openStatus} />}</dd></div>}
                  {businessSnapshot && <div><dt>Tax</dt><dd>{displayExactMoney(businessSnapshot.currency, businessSnapshot.taxTotal)} · {businessSnapshot.lines[0]?.taxDecision.status ?? "No lines"}</dd></div>}
                  {settlementSnapshot && <div><dt>Allocations</dt><dd>{settlementSnapshot.allocations.length} open item{settlementSnapshot.allocations.length === 1 ? "" : "s"}</dd></div>}
                  <div><dt>Journal</dt><dd>{document.journalNumber ? `#${document.journalNumber}` : "Not posted"}</dd></div>
                  {document.voidReason && <div><dt>Void reason</dt><dd>{document.voidReason}</dd></div>}
                </dl>
                <div className="record-actions">
                  {business && document.status === "DRAFT" && workspace.canManage && <button className="secondary-button compact-button" type="button" onClick={() => openDocument(document)} disabled={busy || pending}>Edit draft</button>}
                  {business && document.status === "DRAFT" && workspace.canPost && <button className="primary-button compact-button" type="button" onClick={() => void issueDocument(document)} disabled={busy || pending}>Issue</button>}
                  {business && document.status === "POSTED" && workspace.canSettle && document.openAmount && isPositiveExactAmount(document.openAmount) && <button className="secondary-button compact-button" type="button" onClick={() => openSettlement(document.snapshot.partyAccountId)} disabled={busy || pending}>Record {settlementLabel}</button>}
                  {document.status === "POSTED" && workspace.canVoid && <button className="text-danger-button" type="button" onClick={() => prepareVoid(document)} disabled={busy || pending || (business && partiallySettled)}>{business && partiallySettled ? `Reverse ${settlementLabel} first` : "Void"}</button>}
                </div>
              </article>
            );
          })}
        </section>
      ) : (
        <EmptyState title={`No ${businessLabel}s or ${settlementLabel}s found`}>
          {workspace.canManage ? `Create the first ${businessLabel} draft for this organization.` : "No current source documents match the search."}
        </EmptyState>
      )}
    </>
  );
}
