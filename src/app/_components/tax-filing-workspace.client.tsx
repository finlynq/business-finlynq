"use client";

import { CompactDisclosure } from "./compact-disclosure.client";

import { SectionTabs } from "./section-tabs.client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MutationFeedback } from "@/app/_components/mutation-feedback.client";
import type { TaxFilingField, TaxMappingBalanceBasis } from "@/modules/tax/filing-template";
import Link from "next/link";
import type { TaxFilingReadiness } from "@/modules/tax/filing-readiness";
import { partitionTaxFilingHistory } from "@/modules/tax/filing-history";
import type { TaxFilingWorkspaceDto } from "@/modules/tax/filing-workspace";
import styles from "./tax-filing-workspace.module.css";

type Feedback = Readonly<{ kind: "success" | "error"; message: string }>;

const balanceBasisLabels: Readonly<Record<TaxMappingBalanceBasis, string>> = {
  DEBITS: "Debit activity",
  CREDITS: "Credit activity",
  NET_DEBIT: "Net debit",
  NET_CREDIT: "Net credit",
  ABSOLUTE_NET: "Absolute net",
};

function currentTemplate(workspace: TaxFilingWorkspaceDto, templateId: string) {
  return workspace.templates.find((template) => template.id === templateId) ?? workspace.templates[0] ?? null;
}

function currentLedger(workspace: TaxFilingWorkspaceDto, ledgerId: string) {
  return workspace.ledgers.find((ledger) => ledger.ledgerId === ledgerId) ?? workspace.ledgers[0] ?? null;
}

function effectiveConfiguration(
  workspace: TaxFilingWorkspaceDto,
  input: Readonly<{ ledgerId: string; filingTypeKey?: string; registrationId: string | null; on: string }>,
) {
  if (!input.filingTypeKey || !input.on) return null;
  return [...(workspace.configurations ?? [])]
    .filter((configuration) => (
      configuration.ledgerId === input.ledgerId
      && configuration.filingTypeKey === input.filingTypeKey
      && configuration.registrationId === input.registrationId
      && configuration.effectiveFrom <= input.on
      && (!configuration.effectiveTo || configuration.effectiveTo >= input.on)
    ))
    .sort((left, right) => right.version - left.version || right.effectiveFrom.localeCompare(left.effectiveFrom))[0] ?? null;
}

function effectiveConfigurationsForDate(
  workspace: TaxFilingWorkspaceDto,
  ledgerId: string,
  on: string,
) {
  const byScope = new Map<string, NonNullable<TaxFilingWorkspaceDto["configurations"]>[number]>();
  for (const configuration of workspace.configurations ?? []) {
    if (configuration.ledgerId !== ledgerId || configuration.effectiveFrom > on
        || (configuration.effectiveTo && configuration.effectiveTo < on)) continue;
    const key = `${configuration.registrationId ?? "none"}|${configuration.filingTypeKey}`;
    const current = byScope.get(key);
    if (!current || configuration.version > current.version
        || (configuration.version === current.version && configuration.effectiveFrom > current.effectiveFrom)) {
      byScope.set(key, configuration);
    }
  }
  return [...byScope.values()];
}

function mappingSelections(
  workspace: TaxFilingWorkspaceDto,
  templateId: string,
  ledgerId: string,
) {
  const template = currentTemplate(workspace, templateId);
  const mappings = workspace.mappings.filter(
    (mapping) => mapping.ledgerId === ledgerId && mapping.templateId === templateId,
  );
  const accounts: Record<string, string[]> = {};
  const bases: Record<string, TaxMappingBalanceBasis> = {};
  for (const field of template?.definition.fields.filter((candidate) => candidate.allowAccountMapping) ?? []) {
    const fieldMappings = mappings.filter((mapping) => mapping.fieldKey === field.key);
    accounts[field.key] = fieldMappings.map((mapping) => mapping.glAccountId);
    bases[field.key] = fieldMappings[0]?.balanceBasis ?? field.defaultBalanceBasis ?? "NET_DEBIT";
  }
  return { accounts, bases };
}

function csvRows(serialized: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < serialized.length; index += 1) {
    const character = serialized[index];
    if (character === '"') {
      if (quoted && serialized[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && serialized[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (quoted) throw new Error("The CSV contains an unterminated quoted value.");
  return rows;
}

function fieldLookup(fields: readonly TaxFilingField[]) {
  const lookup = new Map<string, string>();
  for (const field of fields) {
    lookup.set(field.key.toLowerCase(), field.key);
    lookup.set(field.code.toLowerCase().replaceAll(" ", ""), field.key);
  }
  return (value: string) => lookup.get(value.trim().toLowerCase().replaceAll(" ", ""));
}

export function parseTaxFilingCsv(
  serialized: string,
  fields: readonly TaxFilingField[],
): Record<string, string> {
  const rows = csvRows(serialized);
  if (rows.length < 2) throw new Error("The CSV needs a header and at least one value row.");
  const resolve = fieldLookup(fields);
  const values: Record<string, string> = {};
  const firstHeader = rows[0]?.[0]?.trim().toLowerCase();
  if (["field", "field_key", "code", "line"].includes(firstHeader ?? "")) {
    for (const row of rows.slice(1)) {
      const key = resolve(row[0] ?? "");
      if (!key || !(row[1] ?? "").trim()) continue;
      values[key] = row[1]!.replaceAll("$", "").replaceAll(",", "").trim();
    }
  } else {
    const valueRow = rows[1] ?? [];
    for (const [index, header] of (rows[0] ?? []).entries()) {
      const key = resolve(header);
      const value = valueRow[index]?.replaceAll("$", "").replaceAll(",", "").trim();
      if (key && value) values[key] = value;
    }
  }
  if (Object.keys(values).length === 0) {
    throw new Error("No template field keys or line codes were recognized in the CSV.");
  }
  return values;
}

function idempotencyCommand() {
  return { fingerprint: "", key: crypto.randomUUID() };
}

export function TaxFilingWorkspace({ workspace, refreshFilingId }: { workspace: TaxFilingWorkspaceDto; refreshFilingId?: string }) {
  const refreshSource = workspace.filings.find((filing) => filing.id === refreshFilingId);
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const initialConfiguration = [...(workspace.configurations ?? [])]
    .filter((configuration) => configuration.state === "ACTIVE" && configuration.effectiveFrom <= today && (!configuration.effectiveTo || configuration.effectiveTo >= today))
    .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom) || right.version - left.version)[0];
  const initialTemplateId = refreshSource?.freshness.readiness.configuration?.templateId ?? refreshSource?.templateId ?? initialConfiguration?.templateId ?? workspace.templates[0]?.id ?? "";
  const initialLedgerId = refreshSource?.ledgerId ?? initialConfiguration?.ledgerId ?? workspace.ledgers.find(
    (candidate) => candidate.currencyCode === workspace.templates[0]?.currencyCode,
  )?.ledgerId ?? workspace.ledgers[0]?.ledgerId ?? "";
  const initialSelections = mappingSelections(workspace, initialTemplateId, initialLedgerId);
  const [templateId, setTemplateId] = useState(initialTemplateId);
  const [ledgerId, setLedgerId] = useState(initialLedgerId);
  const [accountSelections, setAccountSelections] = useState<Record<string, string[]>>(
    () => initialSelections.accounts,
  );
  const [basisSelections, setBasisSelections] = useState<Record<string, TaxMappingBalanceBasis>>(
    () => initialSelections.bases,
  );
  const [mappingEffectiveFrom, setMappingEffectiveFrom] = useState(today);
  const [mappingReason, setMappingReason] = useState("");
  const [mappingQuery, setMappingQuery] = useState("");
  const [mappingFeedback, setMappingFeedback] = useState<Feedback | null>(null);
  const [mappingBusy, setMappingBusy] = useState(false);
  const mappingCommand = useRef(idempotencyCommand());
  const [mappingCorrectionBusy, setMappingCorrectionBusy] = useState(false);
  const [mappingCorrectionFeedback, setMappingCorrectionFeedback] = useState<Feedback | null>(null);
  const [mappingCorrectionReview, setMappingCorrectionReview] = useState<{
    fingerprint: string; previewHash: string; eligible: boolean;
    proposal: { mappingSetId: string; effectiveFrom: string; effectiveTo?: string; reason: string; mappings: { fieldKey: string; glAccountId: string; balanceBasis: string; multiplier: string }[] };
    current: { id: string; version: number; effective_from: string; effective_to: string | null; template_id: string; template_version: number };
    originalLines: { field_key: string; gl_account_id: string; balance_basis: string; multiplier: string }[];
    predecessor: { id: string; effective_from: string; effective_to: string | null } | null;
    references: { configuration_ids: string[]; workpaper_ids: string[]; successor_count: number };
    affectedPeriods: { id: string; label: string }[];
  } | null>(null);
  const mappingCorrectionCommand = useRef(idempotencyCommand());
  const [configurationReason, setConfigurationReason] = useState("");
  const [configurationEffectiveFrom, setConfigurationEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [configurationEffectiveTo, setConfigurationEffectiveTo] = useState("");
  const [configurationState, setConfigurationState] = useState<"ACTIVE" | "INACTIVE">("ACTIVE");
  const [showConfigurationHistory, setShowConfigurationHistory] = useState(false);
  const [configurationBusy, setConfigurationBusy] = useState(false);
  const configurationCommand = useRef(idempotencyCommand());
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [correctionFeedback, setCorrectionFeedback] = useState<Feedback | null>(null);
  const [correctionReview, setCorrectionReview] = useState<{
    fingerprint: string; previewHash: string; eligible: boolean;
    proposal: { configurationId: string; templateId: string; mappingSetId: string; effectiveFrom: string; effectiveTo: string | null; state: string; reason: string };
    current: { id: string; version: number; effective_from: string; effective_to: string | null; template_id: string; mapping_set_id: string; template_version: number; mapping_version: number };
    proposalSelection: { template_version: number; mapping_version: number } | null;
    predecessor: { id: string; effective_from: string; effective_to: string | null } | null;
    references: { workpaper_count: number; canonical_count: number; successor_count: number; workpaper_ids: string[] };
    affectedPeriods: { id: string; label: string }[];
  } | null>(null);
  const correctionCommand = useRef(idempotencyCommand());

  const [filingType, setFilingType] = useState<"PREPARED" | "HISTORICAL_IMPORT">(refreshSource ? "HISTORICAL_IMPORT" : "PREPARED");
  const [periodStart, setPeriodStart] = useState(refreshSource?.periodStart ?? "");
  const [periodEnd, setPeriodEnd] = useState(refreshSource?.periodEnd ?? "");
  const [externalReference, setExternalReference] = useState(refreshSource?.externalReference ?? (refreshSource ? `Workpaper ${refreshSource.id}` : ""));
  const [sourceFileName, setSourceFileName] = useState(refreshSource?.sourceFileName ?? "");
  const [manualValues, setManualValues] = useState<Record<string, string>>({ ...refreshSource?.manualValues });
  const [reportedValues, setReportedValues] = useState<Record<string, string>>({ ...refreshSource?.reportedValues });
  const [filingFeedback, setFilingFeedback] = useState<Feedback | null>(null);
  const [filingBusy, setFilingBusy] = useState(false);
  const filingCommand = useRef(idempotencyCommand());
  const [readinessResult, setReadinessResult] = useState<{ key: string; value?: TaxFilingReadiness; error?: string } | null>(null);

  const template = currentTemplate(workspace, templateId);
  const ledger = currentLedger(workspace, ledgerId);
  const mappingFields = useMemo(
    () => template?.definition.fields.filter((field) => field.allowAccountMapping) ?? [],
    [template],
  );
  const requiredMappingFields = useMemo(
    () => mappingFields.filter((field) => field.kind === "ACCOUNT" && field.required),
    [mappingFields],
  );
  const manualFields = useMemo(
    () => template?.definition.fields.filter((field) => field.kind === "MANUAL") ?? [],
    [template],
  );
  const ledgerAccounts = useMemo(
    () => workspace.accounts.filter((account) => account.ledgerId === ledgerId),
    [workspace.accounts, ledgerId],
  );
  const latestMappings = useMemo(
    () => workspace.mappings.filter((mapping) => mapping.ledgerId === ledgerId && mapping.templateId === templateId),
    [workspace.mappings, ledgerId, templateId],
  );
  const scopeRegistration = useMemo(
    () => (workspace.registrations ?? []).find((registration) => (
      registration.legalEntityId === ledger?.legalEntityId
      && template?.templateKey === "ca.gst-hst.return" && registration.regimeKey.includes("hst")
    )) ?? null,
    [workspace.registrations, ledger?.legalEntityId, template?.templateKey],
  );
  const currentConfiguration = useMemo(
    () => (workspace.configurations ?? []).find((configuration) => (
      configuration.current
      && configuration.legalEntityId === ledger?.legalEntityId
      && configuration.ledgerId === ledger?.ledgerId
      && configuration.filingTypeKey === template?.templateKey
      && configuration.registrationId === (scopeRegistration?.id ?? null)
    )) ?? null,
    [workspace.configurations, ledger?.legalEntityId, ledger?.ledgerId, template?.templateKey, scopeRegistration?.id],
  );
  const currentMappingVersion = workspace.mappingVersions.find((mapping) => (
    mapping.ledgerId === ledger?.ledgerId && mapping.templateId === template?.id
  ));

  const readinessKey = ledger && template && periodStart && periodEnd && periodStart <= periodEnd
    ? new URLSearchParams({ legalEntityId: ledger.legalEntityId, ledgerId: ledger.ledgerId, templateId: template.id, periodStart, periodEnd }).toString()
    : "";
  const readiness = readinessResult?.key === readinessKey ? readinessResult.value : undefined;
  const readinessError = readinessResult?.key === readinessKey ? readinessResult.error : undefined;
  useEffect(() => {
    if (!readinessKey) return;
    const controller = new AbortController();
    void fetch(`/api/tax/filings/preview?${readinessKey}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Tax coverage could not be checked.");
        if (!controller.signal.aborted) setReadinessResult({ key: readinessKey, value: payload as TaxFilingReadiness });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setReadinessResult({ key: readinessKey, error: error instanceof Error ? error.message : "Tax coverage could not be checked." });
      });
    return () => controller.abort();
  }, [readinessKey, workspace]);

  const selectScope = (nextTemplateId: string, nextLedgerId: string) => {
    const selections = mappingSelections(workspace, nextTemplateId, nextLedgerId);
    setTemplateId(nextTemplateId);
    setLedgerId(nextLedgerId);
    setAccountSelections(selections.accounts);
    setBasisSelections(selections.bases);
    setMappingFeedback(null);
    setMappingCorrectionFeedback(null);
    setMappingCorrectionReview(null);
    setManualValues({});
    setReportedValues({});
    mappingCommand.current = idempotencyCommand();
    mappingCorrectionCommand.current = idempotencyCommand();
    filingCommand.current = idempotencyCommand();
    configurationCommand.current = idempotencyCommand();
    correctionCommand.current = idempotencyCommand();
    setCorrectionReview(null);
  };

  const saveConfiguration = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!template || !ledger || configurationBusy) return;
    const mapping = workspace.mappingVersions.find((candidate) => (
      candidate.ledgerId === ledger.ledgerId && candidate.templateId === template.id && candidate.state === "ACTIVE"
    ));
    if (!mapping) {
      setMappingFeedback({ kind: "error", message: "Save an active mapping version before activating this filing configuration." });
      return;
    }
    const fields = {
      legalEntityId: ledger.legalEntityId,
      ledgerId: ledger.ledgerId,
      registrationId: template.templateKey === "ca.gst-hst.return" ? scopeRegistration?.id ?? null : null,
      filingTypeKey: template.templateKey,
      templateId: template.id,
      mappingSetId: mapping.mappingSetId,
      expectedConfigurationVersion: currentConfiguration?.version ?? 0,
      state: configurationState,
      effectiveFrom: configurationEffectiveFrom,
      ...(configurationEffectiveTo ? { effectiveTo: configurationEffectiveTo } : {}),
      reason: configurationReason.trim(),
    };
    const fingerprint = JSON.stringify(fields);
    if (configurationCommand.current.fingerprint !== fingerprint) configurationCommand.current = { fingerprint, key: crypto.randomUUID() };
    setConfigurationBusy(true); setMappingFeedback(null);
    try {
      const response = await fetch("/api/tax/configurations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, idempotencyKey: configurationCommand.current.key }),
      });
      const payload = await response.json() as { error?: string; version?: number };
      if (!response.ok) throw new Error(payload.error ?? "The filing configuration could not be saved.");
      setMappingFeedback({ kind: "success", message: `Filing configuration version ${payload.version ?? "new"} activated without changing any existing workpaper.` });
      setConfigurationReason(""); router.refresh();
    } catch (error) {
      setMappingFeedback({ kind: "error", message: error instanceof Error ? error.message : "The filing configuration could not be saved." });
    } finally { setConfigurationBusy(false); }
  };

  const correctionProposal = () => {
    if (!template || !ledger || !currentConfiguration) return null;
    const mapping = workspace.mappingVersions.find((candidate) => (
      candidate.ledgerId === ledger.ledgerId && candidate.templateId === template.id && candidate.state === "ACTIVE"
    ));
    if (!mapping) return null;
    return {
      configurationId: currentConfiguration.id,
      legalEntityId: ledger.legalEntityId,
      ledgerId: ledger.ledgerId,
      registrationId: template.templateKey === "ca.gst-hst.return" ? scopeRegistration?.id ?? null : null,
      filingTypeKey: template.templateKey,
      templateId: template.id,
      mappingSetId: mapping.mappingSetId,
      expectedConfigurationVersion: currentConfiguration.version,
      state: configurationState,
      effectiveFrom: configurationEffectiveFrom,
      effectiveTo: configurationEffectiveTo || null,
      reason: configurationReason.trim(),
    };
  };

  const previewCorrection = async () => {
    const proposal = correctionProposal();
    if (!proposal || correctionBusy) return;
    setCorrectionBusy(true); setCorrectionFeedback(null); setCorrectionReview(null);
    try {
      const response = await fetch("/api/tax/configurations/correction/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proposal), cache: "no-store",
      });
      const payload = await response.json() as { error?: string } & Omit<NonNullable<typeof correctionReview>, "fingerprint">;
      if (!response.ok) throw new Error(payload.error ?? "The correction preview could not be loaded.");
      setCorrectionReview({ ...payload, fingerprint: JSON.stringify(proposal) });
    } catch (error) {
      setCorrectionFeedback({ kind: "error", message: error instanceof Error ? error.message : "The correction preview could not be loaded." });
    } finally { setCorrectionBusy(false); }
  };

  const commitCorrection = async () => {
    const proposal = correctionProposal();
    if (!proposal || !correctionReview || !correctionReview.eligible || correctionBusy) return;
    const fingerprint = JSON.stringify(proposal);
    if (fingerprint !== correctionReview.fingerprint) {
      setCorrectionFeedback({ kind: "error", message: "The correction fields changed. Preview the exact dates and references again." });
      setCorrectionReview(null);
      return;
    }
    if (correctionCommand.current.fingerprint !== fingerprint) correctionCommand.current = { fingerprint, key: crypto.randomUUID() };
    setCorrectionBusy(true); setCorrectionFeedback(null);
    try {
      const response = await fetch("/api/tax/configurations/correction", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal, previewHash: correctionReview.previewHash, idempotencyKey: correctionCommand.current.key }),
      });
      const payload = await response.json() as { error?: string; version?: number };
      if (!response.ok) throw new Error(payload.error ?? "The configuration correction could not be saved.");
      setCorrectionFeedback({ kind: "success", message: `Corrected configuration v${payload.version ?? "new"} saved with the original revision retained. Review the final readback before creating another workpaper.` });
      setCorrectionReview(null); router.refresh();
    } catch (error) {
      setCorrectionFeedback({ kind: "error", message: error instanceof Error ? error.message : "The configuration correction could not be saved." });
    } finally { setCorrectionBusy(false); }
  };

  const selectCanonical = async (event: React.FormEvent<HTMLFormElement>, filingId: string, expectedSelectionVersion: number) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    setFilingBusy(true); setFilingFeedback(null);
    try {
      const response = await fetch("/api/tax/filings/canonical", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filingId, expectedSelectionVersion, reason, idempotencyKey: crypto.randomUUID() }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The canonical workpaper could not be selected.");
      setFilingFeedback({ kind: "success", message: "Canonical selection recorded as a new immutable version." }); router.refresh();
    } catch (error) { setFilingFeedback({ kind: "error", message: error instanceof Error ? error.message : "Canonical selection failed." }); }
    finally { setFilingBusy(false); }
  };

  const archiveFiling = async (event: React.FormEvent<HTMLFormElement>, filingId: string, expectedLifecycleVersion: number) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    setFilingBusy(true); setFilingFeedback(null);
    try {
      const response = await fetch("/api/tax/filings/lifecycle", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filingId, expectedLifecycleVersion, state: "ARCHIVED", reason, idempotencyKey: crypto.randomUUID() }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The workpaper could not be archived.");
      setFilingFeedback({ kind: "success", message: "Workpaper archived without deleting filing evidence." }); router.refresh();
    } catch (error) { setFilingFeedback({ kind: "error", message: error instanceof Error ? error.message : "Workpaper archive failed." }); }
    finally { setFilingBusy(false); }
  };

  const selectTemplate = (nextTemplateId: string) => {
    const next = currentTemplate(workspace, nextTemplateId);
    const nextLedgerId = next && ledger?.currencyCode !== next.currencyCode
      ? workspace.ledgers.find((candidate) => candidate.currencyCode === next.currencyCode)?.ledgerId ?? ""
      : ledgerId;
    selectScope(nextTemplateId, nextLedgerId);
  };

  const mappingFieldsInput = () => {
    if (!template || !ledger) return null;
    const mappings = mappingFields.flatMap((field) => (accountSelections[field.key] ?? []).map((glAccountId) => ({
      fieldKey: field.key,
      glAccountId,
      balanceBasis: basisSelections[field.key] ?? field.defaultBalanceBasis ?? "NET_DEBIT",
      multiplier: "1",
    })));
    return {
      legalEntityId: ledger.legalEntityId,
      ledgerId: ledger.ledgerId,
      templateId: template.id,
      expectedTemplateVersion: template.version,
      expectedMappingVersion: currentMappingVersion?.mappingVersion ?? 0,
      effectiveFrom: mappingEffectiveFrom,
      mappings,
      reason: mappingReason.trim(),
    };
  };

  const saveMappings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = mappingFieldsInput();
    if (!fields || mappingBusy) return;
    const fingerprint = JSON.stringify(fields);
    if (mappingCommand.current.fingerprint !== fingerprint) {
      mappingCommand.current = { fingerprint, key: crypto.randomUUID() };
    }
    setMappingBusy(true);
    setMappingFeedback(null);
    try {
      const response = await fetch("/api/tax/mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, idempotencyKey: mappingCommand.current.key }),
      });
      const payload = await response.json() as { error?: string; version?: number };
      if (!response.ok) throw new Error(payload.error ?? "The account mapping could not be saved.");
      setMappingFeedback({ kind: "success", message: `Mapping version ${payload.version ?? "new"} saved. Review and activate a filing configuration using this mapping before creating a new workpaper.` });
      setMappingReason("");
      router.refresh();
    } catch (error) {
      setMappingFeedback({ kind: "error", message: error instanceof Error ? error.message : "The account mapping could not be saved." });
    } finally {
      setMappingBusy(false);
    }
  };

  const mappingCorrectionProposal = () => {
    const fields = mappingFieldsInput();
    return fields && currentMappingVersion?.state === "ACTIVE"
      ? { mappingSetId: currentMappingVersion.mappingSetId, ...fields }
      : null;
  };

  const previewMappingCorrection = async () => {
    const proposal = mappingCorrectionProposal();
    if (!proposal || mappingCorrectionBusy) return;
    setMappingCorrectionBusy(true); setMappingCorrectionFeedback(null); setMappingCorrectionReview(null);
    try {
      const response = await fetch("/api/tax/mappings/correction/preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(proposal),
      });
      const payload = await response.json() as { error?: string } & Omit<NonNullable<typeof mappingCorrectionReview>, "fingerprint">;
      if (!response.ok) throw new Error(payload.error ?? "The mapping correction preview could not be loaded.");
      setMappingCorrectionReview({ ...payload, fingerprint: JSON.stringify(proposal) });
    } catch (error) {
      setMappingCorrectionFeedback({ kind: "error", message: error instanceof Error ? error.message : "The mapping correction preview could not be loaded." });
    } finally { setMappingCorrectionBusy(false); }
  };

  const commitMappingCorrection = async () => {
    const proposal = mappingCorrectionProposal();
    if (!proposal || !mappingCorrectionReview?.eligible || mappingCorrectionBusy) return;
    const fingerprint = JSON.stringify(proposal);
    if (fingerprint !== mappingCorrectionReview.fingerprint) {
      setMappingCorrectionFeedback({ kind: "error", message: "The mapping lines or dates changed. Preview the exact correction again." });
      setMappingCorrectionReview(null);
      return;
    }
    if (mappingCorrectionCommand.current.fingerprint !== fingerprint) {
      mappingCorrectionCommand.current = { fingerprint, key: crypto.randomUUID() };
    }
    setMappingCorrectionBusy(true); setMappingCorrectionFeedback(null);
    try {
      const response = await fetch("/api/tax/mappings/correction", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal, previewHash: mappingCorrectionReview.previewHash, idempotencyKey: mappingCorrectionCommand.current.key }),
      });
      const payload = await response.json() as { error?: string; version?: number };
      if (!response.ok) throw new Error(payload.error ?? "The mapping correction could not be saved.");
      setMappingCorrectionFeedback({ kind: "success", message: `Corrected mapping v${payload.version ?? "new"} saved with the original revision retained. Review the final mapping before configuring a workpaper.` });
      setMappingCorrectionReview(null); router.refresh();
    } catch (error) {
      setMappingCorrectionFeedback({ kind: "error", message: error instanceof Error ? error.message : "The mapping correction could not be saved." });
    } finally { setMappingCorrectionBusy(false); }
  };

  const loadCsv = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !template) return;
    try {
      const values = parseTaxFilingCsv(await file.text(), template.definition.fields);
      setReportedValues(values);
      setSourceFileName(file.name);
      setExternalReference((current) => current || file.name.replace(/\.csv$/i, ""));
      setFilingFeedback({ kind: "success", message: `${Object.keys(values).length} reported values loaded from ${file.name}.` });
    } catch (error) {
      setFilingFeedback({ kind: "error", message: error instanceof Error ? error.message : "The CSV could not be read." });
    } finally {
      event.target.value = "";
    }
  };

  const createFiling = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!template || !ledger || filingBusy) return;
    const selectedConfiguration = effectiveConfiguration(workspace, {
      ledgerId: ledger.ledgerId,
      filingTypeKey: template.templateKey,
      registrationId: template.templateKey === "ca.gst-hst.return" ? scopeRegistration?.id ?? null : null,
      on: periodEnd,
    });
    const fields = {
      legalEntityId: ledger.legalEntityId,
      ledgerId: ledger.ledgerId,
      templateId: template.id,
      ...(selectedConfiguration ? { configurationId: selectedConfiguration.id } : {}),
      filingType,
      ...(refreshSource ? { refreshFromFilingId: refreshSource.id } : {}),
      periodStart,
      periodEnd,
      manualValues: Object.fromEntries(Object.entries(manualValues).filter(([, value]) => value.trim() !== "")),
      reportedValues: filingType === "HISTORICAL_IMPORT"
        ? Object.fromEntries(Object.entries(reportedValues).filter(([, value]) => value.trim() !== ""))
        : {},
      ...(filingType === "HISTORICAL_IMPORT" ? {
        externalReference: externalReference.trim(),
        ...(sourceFileName ? { sourceFileName } : {}),
      } : {}),
    };
    const fingerprint = JSON.stringify(fields);
    if (filingCommand.current.fingerprint !== fingerprint) {
      filingCommand.current = { fingerprint, key: crypto.randomUUID() };
    }
    setFilingBusy(true);
    setFilingFeedback(null);
    try {
      const response = await fetch("/api/tax/filings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, idempotencyKey: filingCommand.current.key }),
      });
      const payload = await response.json() as {
        error?: string;
        status?: string;
        varianceCount?: number;
        failedValidationCount?: number;
      };
      if (!response.ok) throw new Error(payload.error ?? "The filing workpaper could not be created.");
      setFilingFeedback({
        kind: "success",
        message: `${filingType === "PREPARED" ? "Return prepared" : "Historical filing reconciled"}: ${payload.status?.replaceAll("_", " ") ?? "saved"}, ${payload.varianceCount ?? 0} variances, ${payload.failedValidationCount ?? 0} rule exceptions.`,
      });
      router.refresh();
    } catch (error) {
      setFilingFeedback({ kind: "error", message: error instanceof Error ? error.message : "The filing workpaper could not be created." });
    } finally {
      setFilingBusy(false);
    }
  };

  if (!template || !ledger) {
    return <p className="validation-message validation-error">Configure an active ledger and install a tax template before using filing reconciliation.</p>;
  }

  const mappingReady = requiredMappingFields
    .every((field) => (accountSelections[field.key] ?? []).length > 0);
  const periodConfiguration = effectiveConfiguration(workspace, {
    ledgerId,
    filingTypeKey: template.templateKey,
    registrationId: template.templateKey === "ca.gst-hst.return" ? scopeRegistration?.id ?? null : null,
    on: periodEnd || today,
  });
  const configurationReady = periodConfiguration?.state === "ACTIVE"
    && periodConfiguration.templateId === template.id && readiness?.ready === true;
  const activeTemplateIds = new Set(effectiveConfigurationsForDate(workspace, ledgerId, today)
    .filter((configuration) => configuration.state === "ACTIVE")
    .map((configuration) => configuration.templateId));
  const templateOptions = showConfigurationHistory || activeTemplateIds.size === 0
    ? workspace.templates
    : workspace.templates.filter((option) => activeTemplateIds.has(option.id) || option.id === templateId);
  const scopeConfigurations = (workspace.configurations ?? []).filter((item) => (
    item.ledgerId === ledgerId && item.filingTypeKey === template.templateKey
  ));
  const visibleConfigurations = showConfigurationHistory
    ? scopeConfigurations
    : scopeConfigurations.filter((item) => item.current);
  const scopedFilings = workspace.filings.filter((filing) => filing.legalEntityId === ledger.legalEntityId && filing.ledgerId === ledgerId && filing.templateId === templateId);
  const filingControlHistory = partitionTaxFilingHistory(scopedFilings, workspace.templates);
  const visibleFilingControls = showConfigurationHistory
    ? [...filingControlHistory.current, ...filingControlHistory.history]
    : filingControlHistory.current;
  const visibleFeedback = mappingCorrectionFeedback ?? correctionFeedback ?? filingFeedback ?? mappingFeedback;

  return (
    <div className={styles.workspace}>
      {visibleFeedback && <MutationFeedback {...visibleFeedback} onDismiss={() => { setMappingCorrectionFeedback(null); setCorrectionFeedback(null); setMappingFeedback(null); setFilingFeedback(null); }} />}
      <section className={styles.scopeBar} aria-label="Tax filing scope">
        <label><span>Template</span>
          <select value={templateId} onChange={(event) => selectTemplate(event.target.value)}>
            {templateOptions.map((option) => <option key={option.id} value={option.id}>{option.name} · v{option.version}</option>)}
          </select>
        </label>
        <label><span>Client company / ledger</span>
          <select value={ledgerId} disabled={Boolean(refreshSource)} onChange={(event) => selectScope(templateId, event.target.value)}>
            {workspace.ledgers.filter((option) => option.currencyCode === template.currencyCode).map((option) => (
              <option key={option.ledgerId} value={option.ledgerId}>{option.entityCode} · {option.ledgerCode} · {option.currencyCode}</option>
            ))}
          </select>
        </label>
        <div className={styles.scopeStatus}>
          <span>Mapping</span>
          <strong className={mappingReady ? styles.ready : styles.needsAttention}>
            {mappingReady ? `Ready · v${latestMappings[0]?.mappingVersion ?? "new"}` : "Required fields missing"}
          </strong>
        </div>
        <label className={styles.historyToggle}><input type="checkbox" checked={showConfigurationHistory} onChange={(event) => setShowConfigurationHistory(event.target.checked)} /><span>History and inactive</span></label>
      </section>

      <SectionTabs label="Tax preparation sections" defaultSection="tax-workpaper" sections={[
        { id: "tax-configuration", label: "Filing configuration" },
        { id: "tax-mappings", label: "Account mappings" },
        { id: "tax-workpaper", label: "Prepare or reconcile" },
      ]}>
        <section className="panel form-panel" aria-labelledby="tax-configuration-title">
          <div className="panel-heading"><div><p className="eyebrow">Effective tenant setup</p><h2 id="tax-configuration-title">Filing configuration</h2><p>Select the exact template and mapping version that may create workpapers for this entity, registration, filing type, and effective period.</p></div></div>
          <div className={styles.configurationSummary}>
            <div><span>Current state</span><strong>{currentConfiguration?.state.replaceAll("_", " ") ?? "NEEDS CONFIGURATION"}</strong></div>
            <div><span>Template</span><strong>{currentConfiguration ? `${currentConfiguration.templateName} v${currentConfiguration.templateVersion}` : `${template.name} v${template.version} proposed`}</strong></div>
            <div><span>Mapping</span><strong>{currentConfiguration ? `v${currentConfiguration.mappingVersion}` : latestMappings[0] ? `v${latestMappings[0].mappingVersion} proposed` : "Missing"}</strong></div>
            <div><span>Registration</span><strong>{scopeRegistration ? `${scopeRegistration.regimeKey} · ${scopeRegistration.id}` : template.templateKey === "ca.gst-hst.return" ? "Missing" : "Not required"}</strong></div>
          </div>
          <form className="close-form" onSubmit={(event) => { void saveConfiguration(event); }}>
            <div className="form-grid form-grid-three">
              <label><span>Effective from</span><input type="date" value={configurationEffectiveFrom} onChange={(event) => setConfigurationEffectiveFrom(event.target.value)} required /></label>
              <label><span>Effective to</span><input type="date" min={configurationEffectiveFrom} value={configurationEffectiveTo} onChange={(event) => setConfigurationEffectiveTo(event.target.value)} /></label>
              <label><span>Revision state</span><select value={configurationState} onChange={(event) => setConfigurationState(event.target.value as "ACTIVE" | "INACTIVE")}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive prospectively</option></select></label>
              <label className="full-field"><span>Configuration reason</span><textarea value={configurationReason} onChange={(event) => setConfigurationReason(event.target.value)} minLength={8} maxLength={500} required placeholder="Why should this exact template and mapping govern future workpapers?" /></label>
            </div>
            {!workspace.canManageConfigurations && <p className="validation-message">{workspace.capabilities?.manageConfigurations.reason ?? "Configuration activation requires tax.filing.configuration.manage. Ask an authorized organization owner to review access."} <Link href="/app/settings">Review organization access</Link></p>}
            {!workspace.canManageCanonical && <p className="validation-message">Canonical selection and lifecycle changes require tax.filing.canonical.manage independently of configuration and preparation permissions. Ask an authorized owner to review access in <Link href="/app/settings">Organization settings</Link>.</p>}
            <p className="form-footnote">Saving a mapping does not activate it. Activation is a separate review of the exact template and mapping. Activation is versioned and prospective. It never rewrites an existing prepared or historical workpaper and never submits a return.</p>
            <div className="form-actions"><button className="primary-button" disabled={!workspace.canManageConfigurations || configurationBusy || !mappingReady || (template.templateKey === "ca.gst-hst.return" && !scopeRegistration)}>{configurationBusy ? "Activating…" : currentConfiguration ? "Create configuration revision" : "Activate configuration"}</button></div>
          </form>
          {currentConfiguration && workspace.canManageConfigurations && <div className="form-footnote">
            <p>An incorrect unused committed revision can be corrected only after reviewing its exact references. The original revision and audit history remain. Ordinary configuration changes use the prospective action above.</p>
            <button type="button" className="secondary-button" disabled={correctionBusy || configurationBusy || configurationReason.trim().length < 8} onClick={() => { void previewCorrection(); }}>
              {correctionBusy ? "Checking…" : "Preview correction of unused revision"}
            </button>
            {correctionReview && <div className="panel" aria-label="Configuration correction review">
              <h3>Review correction before saving</h3>
              <p>Company {ledger.entityCode} · ledger {ledger.ledgerCode} · {template.templateKey}</p>
              <p>Original v{correctionReview.current.version}: {correctionReview.current.id}, {correctionReview.current.effective_from} to {correctionReview.current.effective_to ?? "open"}; template {correctionReview.current.template_id} v{correctionReview.current.template_version}, mapping {correctionReview.current.mapping_set_id} v{correctionReview.current.mapping_version}.</p>
              <p>Proposed: {correctionReview.proposal.effectiveFrom} to {correctionReview.proposal.effectiveTo ?? "open"}; template {correctionReview.proposal.templateId} v{correctionReview.proposalSelection?.template_version ?? "?"}, mapping {correctionReview.proposal.mappingSetId} v{correctionReview.proposalSelection?.mapping_version ?? "?"}, state {correctionReview.proposal.state}. Reason: {correctionReview.proposal.reason}</p>
              <p>References: {correctionReview.references.workpaper_count} workpapers, {correctionReview.references.canonical_count} canonical decisions, {correctionReview.references.successor_count} successor revisions. {correctionReview.references.workpaper_ids.join(", ")}</p>
              <p>Predecessor: {correctionReview.predecessor ? `${correctionReview.predecessor.id}, from ${correctionReview.predecessor.effective_from}` : "none"}. Affected periods: {correctionReview.affectedPeriods.map((period) => period.label).join(", ") || "none configured"}.</p>
              {!correctionReview.eligible && <p className="validation-message validation-error">This revision is not eligible for correction. Review the scope, version, references and predecessor dates.</p>}
              <button type="button" className="primary-button" disabled={!correctionReview.eligible || correctionBusy || JSON.stringify(correctionProposal()) !== correctionReview.fingerprint} onClick={() => { void commitCorrection(); }}>Save reviewed correction</button>
            </div>}
          </div>}
          <details className="mapping-details"><summary>{showConfigurationHistory ? "Configuration history" : "Current configuration"} ({visibleConfigurations.length})</summary>
            <ul className="checklist large-checklist">{visibleConfigurations.map((item) => <li key={item.id}><div><strong>v{item.version} · {item.state.replaceAll("_", " ")}{item.correctionOfConfigurationId ? " · CORRECTION" : ""}</strong><small>{item.effectiveFrom} – {item.effectiveTo ?? "open"} · template v{item.templateVersion} · mapping v{item.mappingVersion} · {item.dependencyCount} workpaper dependenc{item.dependencyCount === 1 ? "y" : "ies"}</small><small>Reason: {item.reason} · actor {item.createdBy}{item.correctionOfConfigurationId ? ` · corrects ${item.correctionOfConfigurationId}` : ""}</small></div>{item.current && <span className="status-pill status-neutral">CURRENT VERSION</span>}</li>)}</ul>
          </details>
          {(visibleFilingControls.length > 0) && <details className="mapping-details"><summary>{showConfigurationHistory ? "Canonical and lifecycle history" : "Current or latest workpapers"} ({visibleFilingControls.length})</summary>
            <div className={styles.lifecycleList}>{visibleFilingControls.map((filing) => <article key={filing.id}>
              <div><strong>{filing.entityCode} · {filing.periodStart} – {filing.periodEnd}</strong><small>{filing.templateName} v{filing.templateVersion} · mapping v{filing.mappingVersion} · configuration v{filing.configurationVersion ?? "legacy"} · {filing.filingType.replaceAll("_", " ")} · {filing.lifecycleState ?? "HISTORICAL"} · {filing.canonical ? "canonical" : filingControlHistory.current.some((item) => item.id === filing.id) ? "latest candidate, not canonical" : "history, not canonical"}</small><small>Source: {filing.sourceFileName ?? "manual"} · workpaper {filing.id}</small><small>Lifecycle reason: {filing.lifecycleReason ?? "Legacy workpaper"}{filing.replacementFilingId ? ` · replacement ${filing.replacementFilingId}` : ""}{filing.canonicalReason ? ` · canonical reason: ${filing.canonicalReason}` : ""}</small></div>
              {workspace.canManageCanonical && !filing.canonical && !["ARCHIVED", "SUPERSEDED"].includes(filing.lifecycleState ?? "") && <form onSubmit={(event) => { void selectCanonical(event, filing.id, filing.canonicalVersion ?? 0); }}><input name="reason" minLength={8} maxLength={500} required placeholder="Canonical selection reason" /><button className="secondary-button" disabled={filingBusy}>Set canonical</button></form>}
              {workspace.canManageCanonical && !filing.canonical && !["ARCHIVED", "SUPERSEDED"].includes(filing.lifecycleState ?? "") && <form onSubmit={(event) => { void archiveFiling(event, filing.id, filing.lifecycleVersion ?? 1); }}><input name="reason" minLength={8} maxLength={500} required placeholder="Permanent archive reason" /><button className="secondary-button" disabled={filingBusy}>Archive</button></form>}
            </article>)}</div>
          </details>}
        </section>
        <section className="panel form-panel" aria-labelledby="tax-mapping-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Client-specific setup</p>
              <h2 id="tax-mapping-title">Map template fields</h2>
              <p>Choose one or more accounts for any input field. Optional fields remain manually editable when they are not mapped.</p>
            </div>
          </div>
          <form className="close-form" onSubmit={(event) => { void saveMappings(event); }}>
            <label className="full-field"><span>Find a template field</span><input type="search" value={mappingQuery} onChange={(event) => setMappingQuery(event.target.value)} placeholder="Line code or field name" /><small>Filtering only changes the fields shown. Saving keeps mappings for every field.</small></label>
            <div className={styles.mappingList}>
              {mappingFields.filter((field) => `${field.code} ${field.label} ${field.description}`.toLocaleLowerCase().includes(mappingQuery.trim().toLocaleLowerCase())).map((field) => <CompactDisclosure key={field.key} defaultOpen={field.kind === "ACCOUNT" && field.required && !(accountSelections[field.key]?.length)} summary={<>
                <span className="code-chip">{field.code}</span> {field.label}{field.kind === "ACCOUNT" && field.required ? " · required" : " · optional"}
                <span className={styles.mappingSummary}>{(accountSelections[field.key] ?? []).map((id) => ledgerAccounts.find((account) => account.id === id)?.code ?? id).join(", ") || "No ledger mapping"} · {balanceBasisLabels[basisSelections[field.key] ?? field.defaultBalanceBasis ?? "NET_DEBIT"]}</span>
              </>}><fieldset className={styles.mappingField}>
                <legend><span className="code-chip">{field.code}</span> {field.label}{field.kind === "ACCOUNT" && field.required ? " *" : " · optional"}</legend>
                <p>{field.description}</p>
                <label><span>Ledger accounts</span>
                  <select
                    multiple
                    size={Math.min(5, Math.max(3, ledgerAccounts.length))}
                    value={accountSelections[field.key] ?? []}
                    disabled={!workspace.canManageMappings || mappingBusy}
                    onChange={(event) => {
                      const selectedAccountIds = Array.from(
                        event.currentTarget.selectedOptions,
                        (option) => option.value,
                      );
                      setAccountSelections((current) => ({
                        ...current,
                        [field.key]: selectedAccountIds,
                      }));
                      if (selectedAccountIds.length > 0 && field.kind === "MANUAL") {
                        setManualValues((current) => {
                          if (!Object.hasOwn(current, field.key)) return current;
                          const next = { ...current };
                          delete next[field.key];
                          return next;
                        });
                      }
                    }}
                  >
                    {ledgerAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.displayName} · {account.accountClass}</option>)}
                  </select>
                  <small>Use Ctrl/Cmd to select multiple accounts.</small>
                </label>
                <label><span>Balance treatment</span>
                  <select
                    value={basisSelections[field.key] ?? field.defaultBalanceBasis ?? "NET_DEBIT"}
                    disabled={!workspace.canManageMappings || mappingBusy}
                    onChange={(event) => {
                      const balanceBasis = event.currentTarget.value as TaxMappingBalanceBasis;
                      setBasisSelections((current) => ({
                        ...current,
                        [field.key]: balanceBasis,
                      }));
                    }}
                  >
                    {Object.entries(balanceBasisLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              </fieldset></CompactDisclosure>)}
            </div>
            <label><span>Mapping effective from</span><input type="date" required value={mappingEffectiveFrom} disabled={!workspace.canManageMappings || mappingBusy} onChange={(event) => setMappingEffectiveFrom(event.target.value)} /><small>A revision must start after the preceding mapping. Choose a date applicable to the reporting period.</small></label>
            <label><span>Change reason</span>
              <textarea value={mappingReason} minLength={8} maxLength={500} required disabled={!workspace.canManageMappings || mappingBusy} onChange={(event) => setMappingReason(event.target.value)} placeholder="Why does this account mapping apply to this client?" />
            </label>
            {!workspace.canManageMappings && <p className="validation-message">Your role can view tax workpapers but cannot change client mappings.</p>}
            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={!workspace.canManageMappings || mappingBusy || !mappingReady}>{mappingBusy ? "Saving…" : "Save mapping version"}</button>
            </div>
          </form>
          {currentMappingVersion?.state === "ACTIVE" && workspace.canManageMappings && <div className="form-footnote">
            <p>If this committed mapping is unused and its date or account selection is wrong, review an append-only correction. A configuration or workpaper reference blocks this action; ordinary revisions use the save action above.</p>
            <button type="button" className="secondary-button" disabled={mappingCorrectionBusy || mappingBusy || !mappingReady || mappingReason.trim().length < 8} onClick={() => { void previewMappingCorrection(); }}>
              {mappingCorrectionBusy ? "Checking…" : "Preview correction of unused mapping"}
            </button>
            {mappingCorrectionReview && <div className="panel" aria-label="Mapping correction review">
              <h3>Review mapping correction before saving</h3>
              <p>Company {ledger?.entityCode} · ledger {ledger?.ledgerCode} · template {mappingCorrectionReview.current.template_id} v{mappingCorrectionReview.current.template_version}.</p>
              <p>Original v{mappingCorrectionReview.current.version}: {mappingCorrectionReview.current.id}, {mappingCorrectionReview.current.effective_from} to {mappingCorrectionReview.current.effective_to ?? "open"}.</p>
              <p>Proposed: {mappingCorrectionReview.proposal.effectiveFrom} to {mappingCorrectionReview.proposal.effectiveTo ?? "open"}. Reason: {mappingCorrectionReview.proposal.reason}</p>
              <p>Original lines: {mappingCorrectionReview.originalLines.map((line) => `${line.field_key} → ${ledgerAccounts.find((account) => account.id === line.gl_account_id)?.code ?? line.gl_account_id} (${line.balance_basis}, ×${line.multiplier})`).join("; ")}.</p>
              <p>Proposed lines: {mappingCorrectionReview.proposal.mappings.map((line) => `${line.fieldKey} → ${ledgerAccounts.find((account) => account.id === line.glAccountId)?.code ?? line.glAccountId} (${line.balanceBasis}, ×${line.multiplier})`).join("; ")}.</p>
              <p>References: {mappingCorrectionReview.references.configuration_ids.length} configurations ({mappingCorrectionReview.references.configuration_ids.join(", ") || "none"}), {mappingCorrectionReview.references.workpaper_ids.length} workpapers ({mappingCorrectionReview.references.workpaper_ids.join(", ") || "none"}), {mappingCorrectionReview.references.successor_count} successors.</p>
              <p>Predecessor: {mappingCorrectionReview.predecessor ? `${mappingCorrectionReview.predecessor.id}, from ${mappingCorrectionReview.predecessor.effective_from}` : "none"}. Affected periods: {mappingCorrectionReview.affectedPeriods.map((period) => period.label).join(", ") || "none configured"}.</p>
              {!mappingCorrectionReview.eligible && <p className="validation-message validation-error">This mapping is not eligible for correction. Review the scope, version, references and predecessor dates.</p>}
              <button type="button" className="primary-button" disabled={!mappingCorrectionReview.eligible || mappingCorrectionBusy || JSON.stringify(mappingCorrectionProposal()) !== mappingCorrectionReview.fingerprint} onClick={() => { void commitMappingCorrection(); }}>Save reviewed mapping correction</button>
            </div>}
          </div>}
          <details className="mapping-details"><summary>Mapping revision history ({(workspace.mappingHistory ?? []).filter((item) => item.ledgerId === ledgerId && item.templateId === templateId).length})</summary>
            <ul className="checklist large-checklist">{(workspace.mappingHistory ?? []).filter((item) => item.ledgerId === ledgerId && item.templateId === templateId).map((item) => <li key={item.id}><div>
              <strong>v{item.version} · {item.state}{item.correctionOfMappingSetId ? " · CORRECTION" : ""}</strong>
              <small>{item.effectiveFrom} – {item.effectiveTo ?? "open"} · {item.configurationCount} configurations · {item.workpaperCount} workpapers</small>
              <small>Reason: {item.reason} · actor {item.createdBy} · {item.createdAt}{item.correctionOfMappingSetId ? ` · corrects ${item.correctionOfMappingSetId}` : ""}</small>
            </div>{item.current && <span className="status-pill status-neutral">CURRENT VERSION</span>}</li>)}</ul>
          </details>
        </section>

        <section className="panel form-panel" aria-labelledby="tax-filing-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Prepare or reconcile</p>
              <h2 id="tax-filing-title">Tax return workpaper</h2>
              <p>Calculate from posted ledger activity or compare a historical return with the system.</p>
            </div>
          </div>
          <form className="close-form" onSubmit={(event) => { void createFiling(event); }}>
            {refreshSource && <div className="validation-message" role="status"><strong>Review refresh inputs</strong><p>This creates a new immutable comparison of current posted balances. The original snapshot from {refreshSource.capturedAt}, its reported values and its canonical selection remain in history. Review the copied values below; blank means not reported and 0 means explicitly zero.</p>{refreshSource.manualInputsNeedReview && <p>This older workpaper did not retain manual-input presence. Nonzero manual results were recovered; review blank adjustments because an omitted input cannot be distinguished from an old explicit zero.</p>}<a href="/app/tax?view=history">Return to filing history</a></div>}
            <div className={styles.modeSwitch} role="group" aria-label="Filing workflow">
              <button type="button" disabled={Boolean(refreshSource)} className={filingType === "PREPARED" ? styles.activeMode : ""} onClick={() => { setFilingType("PREPARED"); setFilingFeedback(null); }}>Prepare declaration</button>
              <button type="button" className={filingType === "HISTORICAL_IMPORT" ? styles.activeMode : ""} onClick={() => { setFilingType("HISTORICAL_IMPORT"); setFilingFeedback(null); }}>Load historical filing</button>
            </div>
            <div className="form-grid form-grid-three">
              <label><span>Period start</span><input type="date" value={periodStart} readOnly={Boolean(refreshSource)} onChange={(event) => setPeriodStart(event.target.value)} required disabled={filingBusy} /></label>
              <label><span>Period end</span><input type="date" value={periodEnd} readOnly={Boolean(refreshSource)} min={periodStart || undefined} onChange={(event) => setPeriodEnd(event.target.value)} required disabled={filingBusy} /></label>
              <label><span>Currency</span><input value={template.currencyCode} readOnly /></label>
            </div>

            {manualFields.length > 0 && <CompactDisclosure summary={`Manual return adjustments · ${manualFields.filter((field) => manualValues[field.key]?.trim()).length} entered`} attention={manualFields.some((field) => Boolean(manualValues[field.key]?.trim()))}><fieldset className={styles.valueGroup}>
              <legend>Manual return adjustments</legend>
              <p>Enter supported values only for fields without ledger mappings. Mapped fields are calculated automatically; unused fields remain zero.</p>
              <div className={styles.valueGrid}>{manualFields.map((field) => {
                const mappedAccountCount = accountSelections[field.key]?.length ?? 0;
                return <label key={field.key}>
                  <span><span className="code-chip">{field.code}</span> {field.label}</span>
                  <input inputMode="decimal" value={manualValues[field.key] ?? ""} placeholder={mappedAccountCount > 0 ? "Mapped from ledger" : "0.00"} disabled={filingBusy || mappedAccountCount > 0} onChange={(event) => {
                    const value = event.currentTarget.value;
                    setManualValues((current) => ({ ...current, [field.key]: value }));
                  }} />
                  {mappedAccountCount > 0 && <small>{mappedAccountCount} mapped ledger account{mappedAccountCount === 1 ? "" : "s"}; manual entry is disabled.</small>}
                </label>;
              })}</div>
            </fieldset></CompactDisclosure>}

            {filingType === "HISTORICAL_IMPORT" && <>
              <div className="form-grid form-grid-three">
                <label><span>Filing reference</span><input value={externalReference} readOnly={Boolean(refreshSource)} maxLength={200} required disabled={filingBusy} onChange={(event) => setExternalReference(event.target.value)} placeholder="CRA confirmation or internal reference" /></label>
                <label className={styles.fileField}><span>Load CSV</span><input type="file" accept=".csv,text/csv" disabled={filingBusy || Boolean(refreshSource)} onChange={(event) => { void loadCsv(event); }} /><small>Use <code>field,value</code> rows or line codes as column headers.</small></label>
                <label><span>Loaded source</span><input value={sourceFileName || "Manual entry"} readOnly /></label>
              </div>
              <fieldset className={styles.valueGroup}>
                <legend>Values reported on the historical return</legend>
                <p>Imported values remain editable for review. Field keys and CRA line codes are both accepted in CSV files.</p>
                <div className={styles.valueGrid}>{template.definition.fields.filter((field) => field.reconcile).map((field) => <label key={field.key}>
                  <span><span className="code-chip">{field.code}</span> {field.label}</span>
                  <input inputMode="decimal" value={reportedValues[field.key] ?? ""} placeholder="Not reported" disabled={filingBusy} onChange={(event) => {
                    const value = event.currentTarget.value;
                    setReportedValues((current) => ({ ...current, [field.key]: value }));
                  }} />
                </label>)}</div>
              </fieldset>
            </>}

            {readinessKey && <section aria-label="Current tax mapping coverage">
              <h3>Current balances and mapping coverage</h3>
              {!readiness && !readinessError && <p role="status">Checking posted balances and the effective configuration…</p>}
              {readinessError && <p role="alert">{readinessError} Reload to check again.</p>}
              {readiness?.configuration && <p>Calculation uses configuration v{readiness.configuration.version}, mapping v{readiness.configuration.mappingVersion}, and the configured template. Checked {readiness.checkedAt}.</p>}
              {readiness?.blockers.map((blocker) => <p className="validation-message validation-error" key={blocker.code}>{blocker.message} <Link href={blocker.remediationUrl}>Review setup</Link></p>)}
              {readiness?.coverage.required && <><p>Posted book net income: {readiness.coverage.currentBookNetIncome} {template.currencyCode}. Unmapped net income effect: {readiness.coverage.omittedNetIncome} {template.currencyCode}.</p>
                {readiness.coverage.unmappedAccounts.length > 0 && <ul>{readiness.coverage.unmappedAccounts.map((account) => <li key={account.id}>{account.code} · {account.name}: {account.netIncome} {template.currencyCode}{account.hasActivity ? " · posted activity omitted" : " · no period activity"}</li>)}</ul>}
                <p>Missing ledger expenses must be mapped to book net income. Manual Schedule 1 adjustments do not repair mapping coverage.</p></>}
            </section>}
            <p className="form-footnote">Calculations use posted journal lines in the selected date range and mapping version. The resulting workpaper is immutable and does not submit data to {template.authority}.</p>
            {!mappingReady && <p className="validation-message validation-error">Map the required fields in the Account mappings tab before preparing a return.</p>}
            {mappingReady && !configurationReady && <p className="validation-message validation-error">Activate the exact template and mapping in Filing configuration for this period before preparing a return.</p>}
            {!workspace.canPrepareFilings && <p className="validation-message">Your role can view tax workpapers but cannot prepare or import filings.</p>}
            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={!workspace.canPrepareFilings || filingBusy || !mappingReady || !configurationReady}>{filingBusy ? "Calculating…" : refreshSource ? "Refresh / reconcile as new comparison" : filingType === "PREPARED" ? "Prepare return" : "Reconcile historical filing"}</button>
            </div>
          </form>
        </section>
      </SectionTabs>
    </div>
  );
}
