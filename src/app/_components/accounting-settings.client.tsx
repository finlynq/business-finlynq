"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  accountSegmentKeys,
  type AccountSegmentKey,
} from "@/modules/ledger/accounting-configuration-contract";
import type { AccountingConfigurationDto } from "@/modules/ledger/accounting-configuration";
import {
  accountingHierarchyDimensionKeys,
  defaultFinancialStatementGroupCode,
  defaultFinancialStatementGroups,
  financialStatementClasses,
  type AccountingHierarchyDimensionKey,
  type AccountingHierarchyDto,
  type AccountingHierarchyNodeDto,
  type AccountingHierarchyMemberType,
} from "@/modules/ledger/accounting-hierarchy-contract";

type Feedback = Readonly<{ kind: "success" | "error"; message: string }> | null;

async function responseMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof payload?.error === "string" ? payload.error : "The accounting configuration could not be updated.";
}

function localDateTimeDefault(): string {
  const date = new Date();
  date.setSeconds(0, 0);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function localDateDefault(): string {
  return localDateTimeDefault().slice(0, 10);
}

function emptySegmentSelection(): Record<AccountSegmentKey, string> {
  return Object.fromEntries(accountSegmentKeys.map((key) => [key, ""])) as Record<AccountSegmentKey, string>;
}

const hierarchyDimensionLabels: Readonly<Record<AccountingHierarchyDimensionKey, string>> = {
  entity: "Legal entity",
  account: "Natural account",
  subaccount: "Subaccount",
  department: "Department",
  intercompany: "Intercompany entity",
  custom1: "Custom 1",
  custom2: "Custom 2",
  custom3: "Custom 3",
  custom4: "Custom 4",
  custom5: "Custom 5",
  custom6: "Custom 6",
  custom7: "Custom 7",
  custom8: "Custom 8",
};

function freshHierarchyId(): string {
  return crypto.randomUUID();
}

function cloneHierarchyNodes(
  nodes: readonly AccountingHierarchyNodeDto[],
): AccountingHierarchyNodeDto[] {
  const ids = new Map(nodes.map((node) => [node.id, freshHierarchyId()]));
  return nodes.map((node) => ({
    ...node,
    id: ids.get(node.id)!,
    parentId: node.parentId ? ids.get(node.parentId) ?? null : null,
  }));
}

function defaultHierarchyNodes(
  dimensionKey: AccountingHierarchyDimensionKey,
  ledgerId: string | null,
  configuration: AccountingConfigurationDto,
): AccountingHierarchyNodeDto[] {
  if (dimensionKey === "account") {
    const roots = financialStatementClasses.map((statementClass, index) => ({
      id: freshHierarchyId(),
      parentId: null,
      code: statementClass === "ASSET" ? "ASSETS" : statementClass === "LIABILITY" ? "LIABILITIES" : statementClass,
      displayName: statementClass === "ASSET" ? "Assets" : statementClass === "LIABILITY" ? "Liabilities" : statementClass === "EQUITY" ? "Equity" : statementClass === "REVENUE" ? "Revenue" : "Expenses",
      sortOrder: (index + 1) * 100,
      statementClass,
      memberType: null,
      memberId: null,
    } satisfies AccountingHierarchyNodeDto));
    const rootByClass = new Map(roots.map((root) => [root.statementClass, root.id]));
    const groups = defaultFinancialStatementGroups.map((group, index) => ({
      id: freshHierarchyId(),
      parentId: rootByClass.get(group.statementClass) ?? null,
      code: group.code,
      displayName: group.displayName,
      sortOrder: (index + 1) * 100,
      statementClass: null,
      memberType: null,
      memberId: null,
    } satisfies AccountingHierarchyNodeDto));
    const groupByCode = new Map<string, string>(groups.map((group) => [group.code, group.id]));
    const accounts = configuration.entities.find((entity) => entity.ledgerId === ledgerId)?.accounts ?? [];
    return [
      ...roots,
      ...groups,
      ...accounts.map((account, index) => ({
        id: freshHierarchyId(),
        parentId: groupByCode.get(defaultFinancialStatementGroupCode(account.accountClass, account.code))
          ?? rootByClass.get(account.accountClass as typeof financialStatementClasses[number])
          ?? null,
        code: `A_${account.code}`,
        displayName: account.displayName,
        sortOrder: (index + 1) * 10,
        statementClass: null,
        memberType: "ACCOUNT" as const,
        memberId: account.id,
      })),
    ];
  }
  const rootId = freshHierarchyId();
  const root: AccountingHierarchyNodeDto = {
    id: rootId,
    parentId: null,
    code: `ALL_${dimensionKey.toUpperCase()}`,
    displayName: `All ${hierarchyDimensionLabels[dimensionKey]}`,
    sortOrder: 100,
    statementClass: null,
    memberType: null,
    memberId: null,
  };
  if (dimensionKey === "entity" || dimensionKey === "intercompany") {
    return [root, ...configuration.entities.map((entity, index) => ({
      id: freshHierarchyId(),
      parentId: rootId,
      code: `E_${entity.code}`,
      displayName: entity.displayName,
      sortOrder: (index + 1) * 10,
      statementClass: null,
      memberType: "ENTITY" as const,
      memberId: entity.id,
    }))];
  }
  const segment = configuration.segments.find((candidate) => candidate.key === dimensionKey);
  return [root, ...(segment?.values.filter((value) => value.active) ?? []).map((value, index) => ({
    id: freshHierarchyId(),
    parentId: rootId,
    code: `V_${value.code}`,
    displayName: value.displayName,
    sortOrder: (index + 1) * 10,
    statementClass: null,
    memberType: "SEGMENT_VALUE" as const,
    memberId: value.id,
  }))];
}

export function AccountingSettings({
  configuration,
  hierarchies,
  isDemo,
}: Readonly<{
  configuration: AccountingConfigurationDto;
  hierarchies: readonly AccountingHierarchyDto[];
  isDemo: boolean;
}>) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [otp, setOtp] = useState("");
  const [stepUpComplete, setStepUpComplete] = useState(!configuration.requiresMfaStepUp);
  const [reason, setReason] = useState("Update accounting configuration");

  const [entityCode, setEntityCode] = useState("ENT01");
  const [entityName, setEntityName] = useState("");
  const [countryCode, setCountryCode] = useState("CA");
  const [regionCode, setRegionCode] = useState("ON");
  const [functionalCurrency, setFunctionalCurrency] = useState("CAD");
  const [accountingProfile, setAccountingProfile] = useState<"CAN_ASPE" | "US_GAAP_NONPUBLIC">("CAN_ASPE");
  const [fiscalYear, setFiscalYear] = useState(new Date().getFullYear());
  const [postingMode, setPostingMode] = useState<"AUTO_POST" | "REVIEW_REQUIRED">("AUTO_POST");
  const [postingPolicyDrafts, setPostingPolicyDrafts] = useState<Record<string, "AUTO_POST" | "REVIEW_REQUIRED">>(() => (
    Object.fromEntries(configuration.entities.map((entity) => [entity.ledgerId, entity.manualPostingMode]))
  ));

  const enabledCurrencies = useMemo(
    () => configuration.currencies.filter((currency) => currency.enabled),
    [configuration.currencies],
  );
  const [rateSource, setRateSource] = useState(enabledCurrencies[0]?.code ?? "USD");
  const [rateTarget, setRateTarget] = useState(enabledCurrencies[1]?.code ?? enabledCurrencies[0]?.code ?? "CAD");
  const [rate, setRate] = useState("");
  const [rateEffectiveAt, setRateEffectiveAt] = useState(localDateTimeDefault);
  const [rateProvider, setRateProvider] = useState("Manual rate");
  const [segmentDrafts, setSegmentDrafts] = useState(() => Object.fromEntries(
    configuration.segments.map((segment) => [segment.key, {
      displayName: segment.displayName,
      visible: segment.visible,
      required: segment.required,
    }]),
  ));
  const activeSegments = useMemo(
    () => configuration.segments.filter((segment) => segment.state === "ACTIVE_LOCKED"),
    [configuration.segments],
  );
  const [segmentValueKey, setSegmentValueKey] = useState<AccountSegmentKey>(
    activeSegments[0]?.key ?? "subaccount",
  );
  const selectedValueSegment = activeSegments.find((segment) => segment.key === segmentValueKey)
    ?? activeSegments[0];
  const [segmentValueCode, setSegmentValueCode] = useState("");
  const [segmentValueName, setSegmentValueName] = useState("");
  const [segmentValueValidFrom, setSegmentValueValidFrom] = useState(localDateDefault);
  const [segmentValueValidTo, setSegmentValueValidTo] = useState("");
  const initialHierarchy = hierarchies.find((hierarchy) => hierarchy.status === "DRAFT")
    ?? hierarchies[0];
  const [hierarchyDimension, setHierarchyDimension] = useState<AccountingHierarchyDimensionKey>("account");
  const [hierarchyLedgerId, setHierarchyLedgerId] = useState(configuration.entities[0]?.ledgerId ?? "");
  const [hierarchyCode, setHierarchyCode] = useState("PRIMARY_REPORTING");
  const [hierarchyName, setHierarchyName] = useState("Primary reporting hierarchy");
  const [selectedHierarchyId, setSelectedHierarchyId] = useState(initialHierarchy?.id ?? "");
  const selectedHierarchy = hierarchies.find((hierarchy) => hierarchy.id === selectedHierarchyId)
    ?? initialHierarchy;
  const [hierarchyNodes, setHierarchyNodes] = useState<AccountingHierarchyNodeDto[]>(
    () => initialHierarchy ? [...initialHierarchy.nodes] : [],
  );
  const [hierarchyRevision, setHierarchyRevision] = useState(initialHierarchy?.revision ?? 1);
  const [hierarchyEffectiveFrom, setHierarchyEffectiveFrom] = useState(localDateDefault);
  const [hierarchyMemberToAdd, setHierarchyMemberToAdd] = useState("");
  const [combinationEntityId, setCombinationEntityId] = useState(configuration.entities[0]?.id ?? "");
  const combinationEntity = configuration.entities.find((entity) => entity.id === combinationEntityId)
    ?? configuration.entities[0];
  const [combinationAccountId, setCombinationAccountId] = useState(
    configuration.entities[0]?.accounts[0]?.id ?? "",
  );
  const combinationAccount = combinationEntity?.accounts.find((account) => account.id === combinationAccountId)
    ?? combinationEntity?.accounts[0];
  const [combinationIntercompanyId, setCombinationIntercompanyId] = useState("");
  const [combinationSegments, setCombinationSegments] = useState<Record<AccountSegmentKey, string>>(
    emptySegmentSelection,
  );
  const [replacesCombinationId, setReplacesCombinationId] = useState("");
  const replacementCandidates = useMemo(() => configuration.accountCombinations.filter((combination) => (
    combination.active
      && !combination.used
      && combination.legalEntityId === combinationEntity?.id
      && combination.accountId === combinationAccount?.id
  )), [configuration.accountCombinations, combinationAccount?.id, combinationEntity?.id]);
  const [taxEntityId, setTaxEntityId] = useState(configuration.entities[0]?.id ?? "");
  const [taxPackKey, setTaxPackKey] = useState(
    configuration.taxPacks.find((pack) => pack.key === "generic.unsupported")?.key
      ?? configuration.taxPacks[0]?.key
      ?? "",
  );
  const [taxRegistrationReference, setTaxRegistrationReference] = useState("");
  const [taxDestinationCountry, setTaxDestinationCountry] = useState("");
  const [taxDestinationRegion, setTaxDestinationRegion] = useState("");
  const [taxDestinationCity, setTaxDestinationCity] = useState("");
  const [taxLocationCode, setTaxLocationCode] = useState("");
  const [taxValidFrom, setTaxValidFrom] = useState(localDateDefault);
  const [taxValidTo, setTaxValidTo] = useState("");
  const [taxEvidence, setTaxEvidence] = useState("");

  const hierarchyGroups = hierarchyNodes.filter((node) => node.memberType === null);
  const hierarchyMemberOptions = useMemo<readonly {
    id: string;
    label: string;
    memberType: AccountingHierarchyMemberType;
    preferredParentCode?: string;
  }[]>(() => {
    if (!selectedHierarchy) return [];
    if (selectedHierarchy.dimensionKey === "account") {
      const entity = configuration.entities.find((candidate) => candidate.ledgerId === selectedHierarchy.ledgerId);
      return (entity?.accounts ?? []).map((account) => ({
        id: account.id,
        label: `${account.code} — ${account.displayName}`,
        memberType: "ACCOUNT" as const,
        preferredParentCode: defaultFinancialStatementGroupCode(account.accountClass, account.code),
      }));
    }
    if (selectedHierarchy.dimensionKey === "entity" || selectedHierarchy.dimensionKey === "intercompany") {
      return configuration.entities.map((entity) => ({
        id: entity.id,
        label: `${entity.code} — ${entity.displayName}`,
        memberType: "ENTITY" as const,
      }));
    }
    const segment = configuration.segments.find((candidate) => candidate.key === selectedHierarchy.dimensionKey);
    return (segment?.values.filter((value) => value.active) ?? []).map((value) => ({
      id: value.id,
      label: `${value.code} — ${value.displayName}`,
      memberType: "SEGMENT_VALUE" as const,
    }));
  }, [configuration.entities, configuration.segments, selectedHierarchy]);
  const unassignedHierarchyMembers = hierarchyMemberOptions.filter((option) => (
    !hierarchyNodes.some((node) => node.memberId === option.id)
  ));

  async function ensureStepUp(): Promise<boolean> {
    if (isDemo || stepUpComplete) return true;
    if (!/^\d{6}$/.test(otp)) {
      setFeedback({ kind: "error", message: "Enter the current six-digit authenticator code." });
      return false;
    }
    const response = await fetch("/api/auth/mfa/step-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ otp }),
    });
    if (!response.ok) {
      setFeedback({ kind: "error", message: await responseMessage(response) });
      return false;
    }
    setStepUpComplete(true);
    setOtp("");
    return true;
  }

  async function mutate(
    key: string,
    url: string,
    method: "POST" | "PATCH",
    body: unknown,
    success: string,
  ) {
    setBusy(key);
    setFeedback(null);
    try {
      if (!(await ensureStepUp())) return;
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        if (response.status === 428) setStepUpComplete(false);
        throw new Error(await responseMessage(response));
      }
      setFeedback({ kind: "success", message: success });
      router.refresh();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "The accounting configuration could not be updated.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function mutateHierarchy(
    key: string,
    url: string,
    method: "POST" | "PATCH",
    body: unknown,
    success: string,
    requiresStepUp = false,
  ): Promise<Record<string, unknown> | null> {
    setBusy(key);
    setFeedback(null);
    try {
      if (requiresStepUp && !(await ensureStepUp())) return null;
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        if (response.status === 428) setStepUpComplete(false);
        throw new Error(await responseMessage(response));
      }
      const payload = await response.json() as Record<string, unknown>;
      setFeedback({ kind: "success", message: success });
      router.refresh();
      return payload;
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "The accounting hierarchy could not be updated.",
      });
      return null;
    } finally {
      setBusy(null);
    }
  }

  function updateHierarchyNode(
    nodeId: string,
    changes: Partial<AccountingHierarchyNodeDto>,
  ) {
    setHierarchyNodes((current) => current.map((node) => (
      node.id === nodeId ? { ...node, ...changes } : node
    )));
  }

  function removeHierarchyNode(nodeId: string) {
    setHierarchyNodes((current) => current
      .filter((node) => node.id !== nodeId)
      .map((node) => node.parentId === nodeId ? { ...node, parentId: null } : node));
  }

  function openHierarchy(hierarchy: AccountingHierarchyDto) {
    setSelectedHierarchyId(hierarchy.id);
    setHierarchyNodes([...hierarchy.nodes]);
    setHierarchyRevision(hierarchy.revision);
    setHierarchyEffectiveFrom(hierarchy.effectiveFrom ?? localDateDefault());
    setHierarchyMemberToAdd("");
  }

  function selectCountry(next: string) {
    const normalized = next.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
    setCountryCode(normalized);
    if (normalized === "CA") {
      setRegionCode("ON");
      setFunctionalCurrency("CAD");
      setAccountingProfile("CAN_ASPE");
    } else if (normalized === "US") {
      setRegionCode("WA");
      setFunctionalCurrency("USD");
      setAccountingProfile("US_GAAP_NONPUBLIC");
    }
  }

  return (
    <div className="settings-layout">
      {feedback && (
        <div className={`validation-message ${feedback.kind === "error" ? "validation-error" : "validation-success"}`} role={feedback.kind === "error" ? "alert" : "status"}>
          {feedback.message}
        </div>
      )}

      {!isDemo && !stepUpComplete && (
        <section className="panel form-panel" aria-labelledby="accounting-step-up-title">
          <div className="panel-heading"><span className="eyebrow">Security check</span><h2 id="accounting-step-up-title">Verify before changing accounting setup</h2><p>Entity, posting policy, currency, rate, and chart-dimension changes require a fresh authenticator check.</p></div>
          <label className="full-field"><span>Six-digit authenticator code</span><input value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} /></label>
        </section>
      )}

      <section className="panel form-panel" id="legal-entities" aria-labelledby="legal-entity-configuration-title">
        <div className="panel-heading"><span className="eyebrow">Multi-company foundation</span><h2 id="legal-entity-configuration-title">Legal entities & primary ledgers</h2><p>Each company receives an isolated primary ledger, monthly fiscal periods, base chart, posting policy, and functional currency. Tax automation outside Ontario and Washington is held for review.</p></div>
        <div className="table-scroll" tabIndex={0} aria-label="Configured legal entities">
          <table><thead><tr><th>Entity</th><th>Jurisdiction</th><th>Ledger</th><th>Framework</th><th>Functional currency</th><th>Manual-journal policy</th></tr></thead><tbody>{configuration.entities.map((entity) => {
            const policyDraft = postingPolicyDrafts[entity.ledgerId] ?? entity.manualPostingMode;
            return (
            <tr key={entity.id}><td><strong>{entity.code}</strong><small>{entity.displayName}</small></td><td>{entity.countryCode}-{entity.regionCode}</td><td>{entity.ledgerCode}</td><td>{entity.accountingProfile.replaceAll("_", " ")}</td><td>{entity.functionalCurrency}{entity.firstPostedAt ? <small>Posting history exists</small> : <small>Not posted yet</small>}</td><td><div className="record-actions"><select aria-label={`Manual-journal posting policy for ${entity.code}`} value={policyDraft} disabled={!configuration.canManagePostingPolicy || busy !== null} onChange={(event) => setPostingPolicyDrafts((current) => ({ ...current, [entity.ledgerId]: event.target.value as typeof policyDraft }))}><option value="AUTO_POST">Auto-post when authorized</option><option value="REVIEW_REQUIRED">Require review</option></select><button className="secondary-button compact-button" type="button" disabled={!configuration.canManagePostingPolicy || busy !== null || policyDraft === entity.manualPostingMode} onClick={() => void mutate(`posting-policy-${entity.ledgerId}`, "/api/accounting/configuration/posting-policy", "PATCH", { ledgerId: entity.ledgerId, manualMode: policyDraft, expectedVersion: entity.postingPolicyVersion, reason }, `${entity.code} now uses ${policyDraft === "AUTO_POST" ? "authorized auto-posting" : "review-required posting"}.`)}>Save policy</button><small>Version {entity.postingPolicyVersion}</small></div></td></tr>
          );})}</tbody></table>
        </div>
        {configuration.canManageSettings && (
          <form className="close-form" onSubmit={(event) => {
            event.preventDefault();
            void mutate("entity", "/api/accounting/configuration/entities", "POST", {
              code: entityCode,
              displayName: entityName,
              countryCode,
              regionCode,
              functionalCurrency,
              accountingProfile,
              fiscalYear,
              manualPostingMode: postingMode,
              reason,
            }, `${entityCode} and its primary ledger were created.`);
          }}>
            <h3>Add a legal entity</h3>
            <div className="form-grid form-grid-three">
              <label><span>Entity code</span><input value={entityCode} onChange={(event) => setEntityCode(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 16))} pattern="[A-Z0-9][A-Z0-9_-]{0,15}" required /></label>
              <label><span>Legal name</span><input value={entityName} onChange={(event) => setEntityName(event.target.value)} minLength={2} maxLength={200} required /></label>
              <label><span>First fiscal year</span><input type="number" value={fiscalYear} onChange={(event) => setFiscalYear(Number(event.target.value))} min={2000} max={2200} required /></label>
              <label><span>ISO country</span><input value={countryCode} onChange={(event) => selectCountry(event.target.value)} minLength={2} maxLength={2} pattern="[A-Z]{2}" required /></label>
              <label><span>Region code</span><input value={regionCode} onChange={(event) => setRegionCode(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 10))} minLength={2} maxLength={10} required /></label>
              <label><span>Functional currency</span><select value={functionalCurrency} onChange={(event) => setFunctionalCurrency(event.target.value)}>{configuration.currencies.map((currency) => <option key={currency.code} value={currency.code}>{currency.code}</option>)}</select></label>
              <label><span>Accounting framework</span><select value={accountingProfile} onChange={(event) => setAccountingProfile(event.target.value as typeof accountingProfile)}><option value="CAN_ASPE">Canadian ASPE</option><option value="US_GAAP_NONPUBLIC">U.S. GAAP — non-public</option></select></label>
              <label><span>Manual journals</span><select value={postingMode} onChange={(event) => setPostingMode(event.target.value as typeof postingMode)}><option value="AUTO_POST">Auto-post when authorized</option><option value="REVIEW_REQUIRED">Require approval</option></select></label>
            </div>
            <div className="form-actions"><button className="primary-button" type="submit" disabled={busy !== null}>{busy === "entity" ? "Creating…" : "Create entity"}</button></div>
          </form>
        )}
      </section>

      <section className="panel form-panel" id="account-segments" aria-labelledby="account-segments-title">
        <div className="panel-heading"><span className="eyebrow">Chart dimensions</span><h2 id="account-segments-title">Account segments</h2><p>Entity and Account are always present. Optional values remain null internally and render as 0000. Custom 1–8 can be named and hidden; once used, their identity is protected.</p></div>
        <div className="table-scroll" tabIndex={0} aria-label="Account segment configuration">
          <table><thead><tr><th>Key</th><th>Display name</th><th>Lifecycle</th><th>Values</th><th>Incomplete combinations</th><th>Visible</th><th>Required</th><th>Action</th></tr></thead><tbody>{configuration.segments.map((segment) => {
            const draft = segmentDrafts[segment.key] ?? { displayName: segment.displayName, visible: segment.visible, required: segment.required };
            const lockedIdentity = Boolean(segment.protectedUseAt);
            return <tr key={segment.key}>
              <td><strong>{segment.key}</strong>{lockedIdentity && <small>Identity protected after use</small>}</td>
              <td><input aria-label={`Display name for ${segment.key}`} value={draft.displayName} disabled={!configuration.canManageSegments || lockedIdentity} onChange={(event) => setSegmentDrafts((current) => ({ ...current, [segment.key]: { ...draft, displayName: event.target.value } }))} /></td>
              <td><span className="status-pill status-neutral">{segment.state.replaceAll("_", " ")}</span></td>
              <td>{segment.values.filter((value) => value.active).length}<small>{segment.values.length} historical</small></td>
              <td>{segment.missingActiveCombinationCount === 0 ? <span className="status-pill status-success">Complete</span> : <span className="status-pill status-warning">{segment.missingActiveCombinationCount} missing</span>}</td>
              <td><input aria-label={`Visible ${segment.key}`} type="checkbox" checked={draft.visible} disabled={!configuration.canManageSegments} onChange={(event) => setSegmentDrafts((current) => ({ ...current, [segment.key]: { ...draft, visible: event.target.checked } }))} /></td>
              <td><input aria-label={`Required ${segment.key}`} title={segment.missingActiveCombinationCount > 0 ? "Complete or replace every active account combination before requiring this segment." : undefined} type="checkbox" checked={draft.required} disabled={!configuration.canManageSegments || segment.state !== "ACTIVE_LOCKED" || (!draft.required && segment.missingActiveCombinationCount > 0)} onChange={(event) => setSegmentDrafts((current) => ({ ...current, [segment.key]: { ...draft, required: event.target.checked } }))} /></td>
              <td><div className="record-actions">
                {segment.state === "ACTIVE_LOCKED" ? <button className="secondary-button compact-button" type="button" disabled={!configuration.canManageSegments || busy !== null} onClick={() => void mutate(`segment-${segment.key}`, "/api/accounting/configuration/segments", "PATCH", { key: segment.key, ...draft, action: "DEACTIVATE", reason }, `${draft.displayName} was deactivated without deleting history.`)}>Deactivate</button> : <button className="secondary-button compact-button" type="button" disabled={!configuration.canManageSegments || busy !== null} onClick={() => void mutate(`segment-${segment.key}`, "/api/accounting/configuration/segments", "PATCH", { key: segment.key, ...draft, required: false, action: segment.state === "EMPTY" ? "CONFIGURE" : "ACTIVATE", reason }, segment.state === "EMPTY" ? `${draft.displayName} was configured and remains unbound.` : `${draft.displayName} was activated.`)}>{segment.state === "EMPTY" ? "Configure" : "Activate"}</button>}
                <button className="secondary-button compact-button" type="button" disabled={!configuration.canManageSegments || busy !== null} onClick={() => void mutate(`segment-save-${segment.key}`, "/api/accounting/configuration/segments", "PATCH", { key: segment.key, ...draft, action: "CONFIGURE", reason }, `${draft.displayName} settings were saved.`)}>Save</button>
              </div></td>
            </tr>;
          })}</tbody></table>
        </div>
        <p className="panel-note">Required status stays unavailable until every active account combination contains that segment. Replace only an unused combination below; posted identities remain immutable.</p>

        {configuration.canManageSegments && selectedValueSegment && (
          <form className="close-form" onSubmit={(event) => {
            event.preventDefault();
            void mutate("segment-value", "/api/accounting/configuration/segment-values", "POST", {
              definitionKey: selectedValueSegment.key,
              code: segmentValueCode,
              displayName: segmentValueName,
              validFrom: segmentValueValidFrom,
              validTo: segmentValueValidTo || null,
              reason,
            }, `${segmentValueCode} was added to ${selectedValueSegment.displayName}.`);
          }}>
            <h3>Add a segment value</h3>
            <p className="panel-note">Codes are permanent identities after use. <code>0000</code> is reserved for the rendered “not used” value.</p>
            <div className="form-grid form-grid-three">
              <label><span>Segment</span><select value={selectedValueSegment.key} onChange={(event) => setSegmentValueKey(event.target.value as AccountSegmentKey)}>{activeSegments.map((segment) => <option key={segment.id} value={segment.key}>{segment.displayName} ({segment.key})</option>)}</select></label>
              <label><span>Code</span><input value={segmentValueCode} onChange={(event) => setSegmentValueCode(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 16))} pattern="[A-Z0-9][A-Z0-9_-]{0,15}" required /></label>
              <label><span>Display name</span><input value={segmentValueName} onChange={(event) => setSegmentValueName(event.target.value)} minLength={2} maxLength={100} required /></label>
              <label><span>Valid from</span><input type="date" value={segmentValueValidFrom} onChange={(event) => setSegmentValueValidFrom(event.target.value)} required /></label>
              <label><span>Valid to (optional)</span><input type="date" value={segmentValueValidTo} onChange={(event) => setSegmentValueValidTo(event.target.value)} min={segmentValueValidFrom} /></label>
            </div>
            <div className="form-actions"><button className="primary-button" type="submit" disabled={busy !== null || segmentValueCode === "0000"}>{busy === "segment-value" ? "Adding…" : "Add segment value"}</button></div>
          </form>
        )}

        <div className="table-scroll" tabIndex={0} aria-label="Configured segment values">
          <table><thead><tr><th>Segment</th><th>Code</th><th>Name</th><th>Validity</th><th>Status</th></tr></thead><tbody>{configuration.segments.some((segment) => segment.values.length > 0) ? configuration.segments.flatMap((segment) => segment.values.map((value) => (
            <tr key={value.id}><td>{segment.displayName}<small>{segment.key}</small></td><td><code>{value.code}</code></td><td>{value.displayName}</td><td>{value.validFrom}<small>{value.validTo ? `through ${value.validTo}` : "open-ended"}</small></td><td><span className={`status-pill ${value.active ? "status-success" : "status-neutral"}`}>{value.active ? "Active" : "Inactive"}</span></td></tr>
          ))) : <tr><td colSpan={5}>No segment values have been created yet.</td></tr>}</tbody></table>
        </div>

        {configuration.canManageSegments && combinationEntity && combinationAccount && (
          <form className="close-form" onSubmit={(event) => {
            event.preventDefault();
            void mutate("account-combination", "/api/accounting/configuration/account-combinations", "POST", {
              legalEntityId: combinationEntity.id,
              ledgerId: combinationEntity.ledgerId,
              accountId: combinationAccount.id,
              subaccountId: combinationSegments.subaccount || null,
              departmentId: combinationSegments.department || null,
              intercompanyEntityId: combinationIntercompanyId || null,
              custom1Id: combinationSegments.custom1 || null,
              custom2Id: combinationSegments.custom2 || null,
              custom3Id: combinationSegments.custom3 || null,
              custom4Id: combinationSegments.custom4 || null,
              custom5Id: combinationSegments.custom5 || null,
              custom6Id: combinationSegments.custom6 || null,
              custom7Id: combinationSegments.custom7 || null,
              custom8Id: combinationSegments.custom8 || null,
              replacesCombinationId: replacesCombinationId || null,
              reason,
            }, `The ${combinationEntity.code}.${combinationAccount.code} account combination is active.`);
          }}>
            <h3>Create an account combination</h3>
            <p className="panel-note">Choose a value only from its exact segment. Existing posted combinations are preserved; the optional replacement list contains unused identities only.</p>
            <div className="form-grid form-grid-three">
              <label><span>Legal entity</span><select value={combinationEntity.id} onChange={(event) => {
                const nextEntity = configuration.entities.find((entity) => entity.id === event.target.value);
                setCombinationEntityId(event.target.value);
                setCombinationAccountId(nextEntity?.accounts[0]?.id ?? "");
                setCombinationIntercompanyId("");
                setReplacesCombinationId("");
              }}>{configuration.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.code} — {entity.displayName}</option>)}</select></label>
              <label><span>Natural account</span><select value={combinationAccount.id} onChange={(event) => { setCombinationAccountId(event.target.value); setReplacesCombinationId(""); }}>{combinationEntity.accounts.map((account) => <option key={account.id} value={account.id}>{account.code} — {account.displayName}</option>)}</select></label>
              <label><span>Intercompany entity (optional)</span><select value={combinationIntercompanyId} onChange={(event) => setCombinationIntercompanyId(event.target.value)}><option value="">0000 — Not used</option>{configuration.entities.filter((entity) => entity.id !== combinationEntity.id).map((entity) => <option key={entity.id} value={entity.id}>{entity.code} — {entity.displayName}</option>)}</select></label>
              {activeSegments.map((segment) => <label key={segment.id}><span>{segment.displayName}{segment.required ? " (required)" : ""}</span><select value={combinationSegments[segment.key]} required={segment.required} onChange={(event) => setCombinationSegments((current) => ({ ...current, [segment.key]: event.target.value }))}><option value="">0000 — Not used</option>{segment.values.filter((value) => value.active).map((value) => <option key={value.id} value={value.id}>{value.code} — {value.displayName}</option>)}</select></label>)}
              <label className="full-field"><span>Replace an unused combination (optional)</span><select value={replacesCombinationId} onChange={(event) => setReplacesCombinationId(event.target.value)}><option value="">Do not replace an existing combination</option>{replacementCandidates.map((combination) => <option key={combination.id} value={combination.id}>{combination.displayKey} — {combination.accountName}</option>)}</select></label>
            </div>
            <div className="form-actions"><button className="primary-button" type="submit" disabled={busy !== null}>{busy === "account-combination" ? "Creating…" : "Create combination"}</button></div>
          </form>
        )}

        <div className="table-scroll" tabIndex={0} aria-label="Account combinations">
          <table><thead><tr><th>Entity & account</th><th>Displayed key</th><th>Canonical key</th><th>Status</th><th>Usage</th></tr></thead><tbody>{configuration.accountCombinations.length ? configuration.accountCombinations.map((combination) => (
            <tr key={combination.id}><td><strong>{combination.entityCode} · {combination.accountCode}</strong><small>{combination.accountName}</small></td><td><code>{combination.displayKey}</code></td><td><code>{combination.canonicalKey}</code></td><td><span className={`status-pill ${combination.active ? "status-success" : "status-neutral"}`}>{combination.active ? "Active" : "Historical"}</span></td><td>{combination.used ? "Protected after use" : "Unused — replaceable"}{combination.lastUsedAt && <small>Last used {new Date(combination.lastUsedAt).toLocaleDateString()}</small>}</td></tr>
          )) : <tr><td colSpan={5}>No account combinations are configured.</td></tr>}</tbody></table>
        </div>
      </section>

      <section className="panel form-panel" id="reporting-hierarchies" aria-labelledby="reporting-hierarchies-title">
        <div className="panel-heading">
          <span className="eyebrow">Financial presentation</span>
          <h2 id="reporting-hierarchies-title">Reporting hierarchies</h2>
          <p>Build versioned trees for the natural account and every optional dimension. Drafts can be refined freely; publishing is effective-dated, requires fresh verification, and makes that version immutable.</p>
          <p>Financial statements prefer the effective <code>PRIMARY_REPORTING</code> account hierarchy. If that family is unavailable, they use the latest effective published account hierarchy for the ledger, then fall back to the standard account-class roots.</p>
        </div>

        {configuration.canManageSegments && (
          <form className="close-form" onSubmit={(event) => {
            event.preventDefault();
            const ledgerId = hierarchyDimension === "account" ? hierarchyLedgerId : null;
            const nodes = defaultHierarchyNodes(hierarchyDimension, ledgerId, configuration);
            void mutateHierarchy(
              "hierarchy-create",
              "/api/accounting/configuration/hierarchies",
              "POST",
              {
                dimensionKey: hierarchyDimension,
                ledgerId,
                code: hierarchyCode,
                displayName: hierarchyName,
                basedOnHierarchyId: null,
                nodes,
                reason,
              },
              `${hierarchyName} draft was created with all current members.`,
            ).then((payload) => {
              if (typeof payload?.id === "string") {
                setSelectedHierarchyId(payload.id);
                setHierarchyNodes(nodes);
                setHierarchyRevision(typeof payload.revision === "number" ? payload.revision : 1);
              }
            });
          }}>
            <h3>Create a hierarchy draft</h3>
            <p className="panel-note">The initial draft includes every current active member. Natural accounts start below Assets, Liabilities, Equity, Revenue, and Expenses so reports remain useful before further grouping.</p>
            <div className="form-grid form-grid-three">
              <label><span>Dimension</span><select value={hierarchyDimension} onChange={(event) => setHierarchyDimension(event.target.value as AccountingHierarchyDimensionKey)}>{accountingHierarchyDimensionKeys.map((key) => <option key={key} value={key}>{hierarchyDimensionLabels[key]}</option>)}</select></label>
              {hierarchyDimension === "account" && <label><span>Ledger</span><select value={hierarchyLedgerId} onChange={(event) => setHierarchyLedgerId(event.target.value)}>{configuration.entities.map((entity) => <option key={entity.ledgerId} value={entity.ledgerId}>{entity.code} — {entity.ledgerCode}</option>)}</select></label>}
              <label><span>Hierarchy code</span><input value={hierarchyCode} onChange={(event) => setHierarchyCode(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32))} pattern="[A-Z0-9][A-Z0-9_-]{0,31}" required /></label>
              <label><span>Display name</span><input value={hierarchyName} onChange={(event) => setHierarchyName(event.target.value)} minLength={2} maxLength={160} required /></label>
            </div>
            <div className="form-actions"><button className="primary-button" type="submit" disabled={busy !== null || (hierarchyDimension === "account" && !hierarchyLedgerId)}>{busy === "hierarchy-create" ? "Creating…" : "Create draft"}</button></div>
          </form>
        )}

        <div className="table-scroll" tabIndex={0} aria-label="Reporting hierarchy versions">
          <table><thead><tr><th>Hierarchy</th><th>Scope</th><th>Version</th><th>Status</th><th>Effective</th><th>Action</th></tr></thead><tbody>{hierarchies.length ? hierarchies.map((hierarchy) => {
            const entity = configuration.entities.find((candidate) => candidate.ledgerId === hierarchy.ledgerId);
            const familyHasDraft = hierarchies.some((candidate) => candidate.status === "DRAFT"
              && candidate.dimensionKey === hierarchy.dimensionKey
              && candidate.ledgerId === hierarchy.ledgerId
              && candidate.code === hierarchy.code);
            return <tr key={hierarchy.id}>
              <td><strong>{hierarchy.displayName}</strong><small>{hierarchy.code}</small></td>
              <td>{hierarchyDimensionLabels[hierarchy.dimensionKey]}<small>{entity ? `${entity.code} · ${entity.ledgerCode}` : "Organization-wide"}</small></td>
              <td>{hierarchy.version}<small>Revision {hierarchy.revision}</small></td>
              <td><span className={`status-pill ${hierarchy.status === "PUBLISHED" ? "status-success" : "status-warning"}`}>{hierarchy.status}</span></td>
              <td>{hierarchy.effectiveFrom ?? "Not published"}</td>
              <td><div className="record-actions">
                <button type="button" className="secondary-button compact-button" onClick={() => openHierarchy(hierarchy)}>{selectedHierarchy?.id === hierarchy.id ? "Selected" : "Open"}</button>
                {configuration.canManageSegments && hierarchy.status === "PUBLISHED" && <button type="button" className="secondary-button compact-button" disabled={busy !== null || familyHasDraft} title={familyHasDraft ? "Open the existing draft for this hierarchy." : undefined} onClick={() => {
                  const nodes = cloneHierarchyNodes(hierarchy.nodes);
                  void mutateHierarchy(
                    `hierarchy-revise-${hierarchy.id}`,
                    "/api/accounting/configuration/hierarchies",
                    "POST",
                    {
                      dimensionKey: hierarchy.dimensionKey,
                      ledgerId: hierarchy.ledgerId,
                      code: hierarchy.code,
                      displayName: hierarchy.displayName,
                      basedOnHierarchyId: hierarchy.id,
                      nodes,
                      reason,
                    },
                    `Version ${hierarchy.version + 1} draft was created.`,
                  ).then((payload) => {
                    if (typeof payload?.id === "string") {
                      setSelectedHierarchyId(payload.id);
                      setHierarchyNodes(nodes);
                      setHierarchyRevision(typeof payload.revision === "number" ? payload.revision : 1);
                    }
                  });
                }}>{familyHasDraft ? "Draft exists" : "Create next draft"}</button>}
              </div></td>
            </tr>;
          }) : <tr><td colSpan={6}>No reporting hierarchies exist yet. Create a draft to organize financial statements or segment inquiries.</td></tr>}</tbody></table>
        </div>

        {selectedHierarchy && (
          <div className="close-form">
            <div>
              <h3>{selectedHierarchy.displayName} · version {selectedHierarchy.version}</h3>
              <p className="panel-note">Group rows define the presentation tree. Member rows bind exactly one ledger account, segment value, or legal entity; posting combinations are not changed.</p>
            </div>
            {selectedHierarchy.status === "DRAFT" && configuration.canManageSegments && <div className="form-actions">
              <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => {
                const suffix = hierarchyNodes.filter((node) => node.memberType === null).length + 1;
                setHierarchyNodes((current) => [...current, {
                  id: freshHierarchyId(),
                  parentId: selectedHierarchy.dimensionKey === "account"
                    ? hierarchyGroups.find((group) => group.parentId === null)?.id ?? null
                    : null,
                  code: `GROUP_${suffix}`,
                  displayName: `New group ${suffix}`,
                  sortOrder: suffix * 100,
                  statementClass: null,
                  memberType: null,
                  memberId: null,
                }]);
              }}>Add group</button>
              <select aria-label="Unassigned hierarchy member" value={hierarchyMemberToAdd} onChange={(event) => setHierarchyMemberToAdd(event.target.value)}><option value="">Choose an unassigned member</option>{unassignedHierarchyMembers.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
              <button type="button" className="secondary-button" disabled={busy !== null || !hierarchyMemberToAdd} onClick={() => {
                const member = hierarchyMemberOptions.find((option) => option.id === hierarchyMemberToAdd);
                if (!member) return;
                const rawCode = member.label.split(" — ")[0] ?? "MEMBER";
                const preferredParent = hierarchyGroups.find((group) => group.code === member.preferredParentCode)
                  ?? hierarchyGroups[0];
                setHierarchyNodes((current) => [...current, {
                  id: freshHierarchyId(),
                  parentId: preferredParent?.id ?? null,
                  code: `M_${rawCode}`.replace(/[^A-Z0-9_-]/gi, "_").toUpperCase().slice(0, 32),
                  displayName: member.label.split(" — ").slice(1).join(" — ") || member.label,
                  sortOrder: current.length * 10 + 10,
                  statementClass: null,
                  memberType: member.memberType,
                  memberId: member.id,
                }]);
                setHierarchyMemberToAdd("");
              }}>Add member</button>
            </div>}
            <div className="table-scroll" tabIndex={0} aria-label={`${selectedHierarchy.displayName} hierarchy nodes`}>
              <table><thead><tr><th>Code & name</th><th>Type / member</th><th>Parent group</th><th>Statement class</th><th>Order</th>{selectedHierarchy.status === "DRAFT" && configuration.canManageSegments && <th>Action</th>}</tr></thead><tbody>{hierarchyNodes.length ? hierarchyNodes.map((node) => {
                const editable = selectedHierarchy.status === "DRAFT" && configuration.canManageSegments;
                const member = node.memberId ? hierarchyMemberOptions.find((option) => option.id === node.memberId) : null;
                return <tr key={node.id}>
                  <td>{editable ? <><input aria-label={`Code for ${node.displayName}`} value={node.code} onChange={(event) => updateHierarchyNode(node.id, { code: event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32) })} /><input aria-label={`Name for ${node.code}`} value={node.displayName} onChange={(event) => updateHierarchyNode(node.id, { displayName: event.target.value })} /></> : <><strong>{node.displayName}</strong><small>{node.code}</small></>}</td>
                  <td>{node.memberType ? <><span className="status-pill status-neutral">{node.memberType.replaceAll("_", " ")}</span><small>{member?.label ?? node.memberId}</small></> : <strong>Group</strong>}</td>
                  <td>{editable ? <select aria-label={`Parent for ${node.displayName}`} value={node.parentId ?? ""} onChange={(event) => updateHierarchyNode(node.id, { parentId: event.target.value || null })}><option value="">Top level</option>{hierarchyGroups.filter((group) => group.id !== node.id).map((group) => <option key={group.id} value={group.id}>{group.code} — {group.displayName}</option>)}</select> : hierarchyGroups.find((group) => group.id === node.parentId)?.displayName ?? "Top level"}</td>
                  <td>{editable && node.memberType === null && selectedHierarchy.dimensionKey === "account" ? <select aria-label={`Statement class for ${node.displayName}`} value={node.statementClass ?? ""} onChange={(event) => updateHierarchyNode(node.id, { statementClass: event.target.value ? event.target.value as AccountingHierarchyNodeDto["statementClass"] : null })}><option value="">Presentation group</option>{financialStatementClasses.map((value) => <option key={value} value={value}>{value}</option>)}</select> : node.statementClass ?? "—"}</td>
                  <td>{editable ? <input aria-label={`Order for ${node.displayName}`} type="number" min={0} max={1000000} value={node.sortOrder} onChange={(event) => updateHierarchyNode(node.id, { sortOrder: Number(event.target.value) })} /> : node.sortOrder}</td>
                  {editable && <td><button type="button" className="secondary-button compact-button" onClick={() => removeHierarchyNode(node.id)}>Remove</button></td>}
                </tr>;
              }) : <tr><td colSpan={selectedHierarchy.status === "DRAFT" && configuration.canManageSegments ? 6 : 5}>This hierarchy has no nodes yet.</td></tr>}</tbody></table>
            </div>
            {selectedHierarchy.status === "DRAFT" && configuration.canManageSegments && <div className="form-actions">
              <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void mutateHierarchy(
                `hierarchy-save-${selectedHierarchy.id}`,
                `/api/accounting/configuration/hierarchies/${selectedHierarchy.id}`,
                "PATCH",
                { expectedRevision: hierarchyRevision, nodes: hierarchyNodes, reason },
                `${selectedHierarchy.displayName} draft was saved.`,
              ).then((payload) => {
                if (typeof payload?.revision === "number") setHierarchyRevision(payload.revision);
              })}>{busy === `hierarchy-save-${selectedHierarchy.id}` ? "Saving…" : "Save draft"}</button>
              <label><span>Effective from</span><input type="date" value={hierarchyEffectiveFrom} onChange={(event) => setHierarchyEffectiveFrom(event.target.value)} required /></label>
              <button type="button" className="primary-button" disabled={busy !== null || hierarchyNodes.length === 0} onClick={() => void mutateHierarchy(
                `hierarchy-publish-${selectedHierarchy.id}`,
                `/api/accounting/configuration/hierarchies/${selectedHierarchy.id}/publish`,
                "POST",
                { expectedRevision: hierarchyRevision, effectiveFrom: hierarchyEffectiveFrom, reason },
                `${selectedHierarchy.displayName} was published effective ${hierarchyEffectiveFrom}.`,
                true,
              )}>{busy === `hierarchy-publish-${selectedHierarchy.id}` ? "Publishing…" : "Publish immutable version"}</button>
            </div>}
          </div>
        )}
      </section>

      <section className="panel form-panel" id="currencies" aria-labelledby="currency-configuration-title">
        <div className="panel-heading"><span className="eyebrow">Multi-currency</span><h2 id="currency-configuration-title">Currencies & effective-dated rates</h2><p>Enable only currencies used by this business. Rates are append-only snapshots expressed as target-currency units for one source-currency unit.</p></div>
        <div className="currency-toggle-grid">{configuration.currencies.map((currency) => (
          <label className="currency-toggle" key={currency.code}><input type="checkbox" checked={currency.enabled} disabled={!configuration.canManageSettings || currency.functional || busy !== null} onChange={(event) => void mutate(`currency-${currency.code}`, "/api/accounting/configuration/currencies", "PATCH", { currencyCode: currency.code, enabled: event.target.checked, reason }, `${currency.code} was ${event.target.checked ? "enabled" : "disabled"}.`)} /><span><strong>{currency.code}</strong><small>{currency.minorUnits} decimal places{currency.functional ? " · functional currency" : ""}</small></span></label>
        ))}</div>
        {configuration.canManageSettings && enabledCurrencies.length >= 2 && (
          <form className="close-form" onSubmit={(event) => {
            event.preventDefault();
            void mutate("rate", "/api/accounting/configuration/rates", "POST", {
              sourceCurrency: rateSource,
              targetCurrency: rateTarget,
              rate,
              effectiveAt: new Date(rateEffectiveAt).toISOString(),
              source: rateProvider,
              reason,
            }, `The ${rateSource}/${rateTarget} rate was recorded without overwriting prior evidence.`);
          }}>
            <h3>Record an exchange-rate snapshot</h3>
            <div className="form-grid form-grid-three">
              <label><span>Source currency</span><select value={rateSource} onChange={(event) => setRateSource(event.target.value)}>{enabledCurrencies.map((currency) => <option key={currency.code} value={currency.code}>{currency.code}</option>)}</select></label>
              <label><span>Target currency</span><select value={rateTarget} onChange={(event) => setRateTarget(event.target.value)}>{enabledCurrencies.map((currency) => <option key={currency.code} value={currency.code}>{currency.code}</option>)}</select></label>
              <label><span>Target per 1 source</span><input value={rate} onChange={(event) => setRate(event.target.value)} inputMode="decimal" pattern="\d+(\.\d{1,18})?" placeholder="1.356200" required /></label>
              <label><span>Effective date & time</span><input type="datetime-local" value={rateEffectiveAt} onChange={(event) => setRateEffectiveAt(event.target.value)} required /></label>
              <label><span>Rate source</span><input value={rateProvider} onChange={(event) => setRateProvider(event.target.value)} minLength={2} maxLength={100} required /></label>
            </div>
            <div className="form-actions"><button className="primary-button" type="submit" disabled={busy !== null || rateSource === rateTarget}>{busy === "rate" ? "Recording…" : "Record rate"}</button></div>
          </form>
        )}
        <div className="table-scroll" tabIndex={0} aria-label="Exchange rate history">
          <table><thead><tr><th>Pair</th><th>Rate</th><th>Effective</th><th>Source</th></tr></thead><tbody>{configuration.rates.length ? configuration.rates.map((entry) => (
            <tr key={entry.id}><td><strong>{entry.sourceCurrency} → {entry.targetCurrency}</strong></td><td>{entry.rate.replace(/0+$/, "").replace(/\.$/, "")}</td><td>{new Date(entry.effectiveAt).toLocaleString()}</td><td>{entry.source}</td></tr>
          )) : <tr><td colSpan={4}>No organization exchange-rate snapshots have been recorded yet.</td></tr>}</tbody></table>
        </div>
      </section>

      <section className="panel form-panel" id="tax-packs" aria-labelledby="tax-pack-configuration-title">
        <div className="panel-heading"><span className="eyebrow">Tax safety</span><h2 id="tax-pack-configuration-title">Registrations, sourcing facts & installed packs</h2><p>Registration references are encrypted with the organization key. Configuration is effective-dated and append-only from this screen, so a new row preserves the prior setup instead of rewriting it.</p></div>
        <div className="table-scroll" tabIndex={0} aria-label="Entity tax registration history">
          <table><thead><tr><th>Entity & pack</th><th>Registration</th><th>Explicit destination</th><th>Validity</th><th>Decision path</th><th>Evidence</th></tr></thead><tbody>{configuration.taxRegistrations.length ? configuration.taxRegistrations.map((registration) => (
            <tr key={registration.id}>
              <td><strong>{registration.entityCode}</strong><small>{registration.regimeKey}</small></td>
              <td><code>{registration.registrationReference}</code></td>
              <td>{registration.destinationCountry && registration.destinationRegion ? `${registration.destinationCountry}-${registration.destinationRegion}` : "Not configured"}<small>{[registration.destinationCity, registration.locationCode].filter(Boolean).join(" · ") || "No city/location code"}</small></td>
              <td>{registration.validFrom}<small>{registration.validTo ? `through ${registration.validTo}` : "open-ended"}</small></td>
              <td><span className={`status-pill ${registration.automationStatus === "AUTOMATED" ? "status-success" : "status-warning"}`}>{registration.automationStatus === "AUTOMATED" ? "Automated" : "Manual review"}</span></td>
              <td>{registration.configurationEvidence ?? "Legacy row — evidence required"}</td>
            </tr>
          )) : <tr><td colSpan={6}>No tax registration has been configured. Documents remain in manual tax review.</td></tr>}</tbody></table>
        </div>
        {configuration.canManageSettings && (
          <form className="close-form" onSubmit={(event) => {
            event.preventDefault();
            void mutate("tax-registration", "/api/accounting/configuration/tax-registrations", "POST", {
              legalEntityId: taxEntityId,
              regimeKey: taxPackKey,
              registrationReference: taxRegistrationReference,
              destinationCountry: taxDestinationCountry,
              destinationRegion: taxDestinationRegion,
              destinationCity: taxDestinationCity,
              locationCode: taxLocationCode,
              configurationEvidence: taxEvidence,
              validFrom: taxValidFrom,
              validTo: taxValidTo || null,
              reason,
            }, "The effective-dated tax registration was added; earlier rows were preserved.");
          }}>
            <h3>Add an effective-dated tax configuration</h3>
            <p className="panel-note">Enter sourcing facts explicitly. The system never fills Seattle or location code 1726 from the entity address. The current Washington pack automates only an explicit US-WA / Seattle / 1726 combination; every other combination stays in manual review.</p>
            <div className="form-grid form-grid-three">
              <label><span>Legal entity</span><select value={taxEntityId} onChange={(event) => setTaxEntityId(event.target.value)} required>{configuration.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.code} — {entity.displayName}</option>)}</select></label>
              <label><span>Installed tax pack</span><select value={taxPackKey} onChange={(event) => setTaxPackKey(event.target.value)} required>{configuration.taxPacks.map((pack) => <option key={`${pack.key}-${pack.version}`} value={pack.key}>{pack.key} ({pack.version})</option>)}</select></label>
              <label><span>Registration reference</span><input value={taxRegistrationReference} onChange={(event) => setTaxRegistrationReference(event.target.value)} minLength={2} maxLength={200} autoComplete="off" required /></label>
              <label><span>Destination country (ISO)</span><input value={taxDestinationCountry} onChange={(event) => setTaxDestinationCountry(event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2))} pattern="[A-Z]{2}" minLength={2} maxLength={2} placeholder="CA" required /></label>
              <label><span>Destination region</span><input value={taxDestinationRegion} onChange={(event) => setTaxDestinationRegion(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 10))} pattern="[A-Z0-9-]{2,10}" minLength={2} maxLength={10} placeholder="ON" required /></label>
              <label><span>Destination city (optional)</span><input value={taxDestinationCity} onChange={(event) => setTaxDestinationCity(event.target.value)} maxLength={100} placeholder="Explicit sourcing city" /></label>
              <label><span>Location code (optional)</span><input value={taxLocationCode} onChange={(event) => setTaxLocationCode(event.target.value.toUpperCase().slice(0, 40))} maxLength={40} placeholder="Verified authority code" /></label>
              <label><span>Valid from</span><input type="date" value={taxValidFrom} onChange={(event) => setTaxValidFrom(event.target.value)} required /></label>
              <label><span>Valid to (optional)</span><input type="date" value={taxValidTo} onChange={(event) => setTaxValidTo(event.target.value)} min={taxValidFrom} /></label>
              <label className="full-field"><span>Configuration evidence</span><input value={taxEvidence} onChange={(event) => setTaxEvidence(event.target.value)} minLength={8} maxLength={1000} placeholder="Authority lookup, working paper, or configuration ticket" required /></label>
            </div>
            <div className="form-actions"><button className="primary-button" type="submit" disabled={busy !== null || !taxEntityId || !taxPackKey}>{busy === "tax-registration" ? "Recording…" : "Add tax configuration"}</button></div>
          </form>
        )}
        <h3>Installed tax-pack versions</h3>
        <div className="table-scroll" tabIndex={0} aria-label="Installed tax pack versions"><table><thead><tr><th>Pack</th><th>Version</th><th>Effective from</th><th>Effective to</th></tr></thead><tbody>{configuration.taxPacks.map((pack) => <tr key={`${pack.key}-${pack.version}`}><td>{pack.key}</td><td>{pack.version}</td><td>{pack.effectiveFrom}</td><td>{pack.effectiveTo ?? "Current"}</td></tr>)}</tbody></table></div>
        <p className="panel-note"><strong>Supported automation:</strong> Ontario HST and the currently installed Seattle Washington sales/use-tax version. Every other jurisdiction uses <code>generic.unsupported</code> or a manual-review decision; the system never assumes a zero rate.</p>
      </section>

      {(configuration.canManageSettings || configuration.canManageSegments || configuration.canManagePostingPolicy) && (
        <section className="panel form-panel" aria-labelledby="configuration-audit-title">
          <div className="panel-heading"><span className="eyebrow">Audit context</span><h2 id="configuration-audit-title">Reason for changes</h2></div>
          <label className="full-field"><span>Audit reason</span><input value={reason} onChange={(event) => setReason(event.target.value)} minLength={8} maxLength={500} required /></label>
        </section>
      )}
    </div>
  );
}
