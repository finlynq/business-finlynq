"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { BankingWorkspaceDto } from "@/modules/banking/banking-workspace";
import { formatExactCurrencyAmount } from "@/modules/banking/exact-money";
import { StatusPill } from "./ui";
import styles from "./banking-workspace.module.css";

type View = "connections" | "reconciliation" | "rules";

async function mutation(url: string, method: "POST" | "PUT", body: unknown) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "The request could not be completed.");
  return payload;
}

function displayDate(value: string | null): string {
  if (!value) return "Never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

function displayAmount(amount: string, currency: string): string {
  return formatExactCurrencyAmount(amount, currency);
}

function Feedback({ message, error }: { message: string; error: boolean }) {
  if (!message) return null;
  return <p role={error ? "alert" : "status"} className={`${styles.feedback} ${error ? styles.error : ""}`}>{message}</p>;
}

function ConnectionView({ workspace }: { workspace: BankingWorkspaceDto }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true); setMessage(""); setError(false);
    try {
      await mutation("/api/banking/connections/simplefin", "POST", {
        displayName: values.get("displayName"),
        setupToken: values.get("setupToken"),
        idempotencyKey: crypto.randomUUID(),
      });
      form.reset();
      setMessage("SimpleFIN was connected. Run the first synchronization to discover its accounts.");
      router.refresh();
    } catch (caught) {
      setError(true); setMessage(caught instanceof Error ? caught.message : "Connection failed.");
    } finally { setBusy(false); }
  }

  async function sync(connectionId: string) {
    setBusy(true); setMessage(""); setError(false);
    try {
      const result = await mutation(`/api/banking/connections/${connectionId}/sync`, "POST", {}) as { versionCount?: number; warningCount?: number };
      setMessage(`Synchronization completed: ${result.versionCount ?? 0} new observation version(s), ${result.warningCount ?? 0} provider warning(s).`);
      router.refresh();
    } catch (caught) {
      setError(true); setMessage(caught instanceof Error ? caught.message : "Synchronization failed.");
      router.refresh();
    } finally { setBusy(false); }
  }

  async function reauthorize(event: FormEvent<HTMLFormElement>, connectionId: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const setupToken = String(new FormData(form).get("setupToken") ?? "").trim();
    setBusy(true); setMessage(""); setError(false);
    try {
      await mutation(`/api/banking/connections/${connectionId}/reauthorize`, "POST", {
        setupToken,
        idempotencyKey: crypto.randomUUID(),
      });
      form.reset();
      setMessage("The encrypted SimpleFIN credential was replaced and the retained connection is active.");
      router.refresh();
    } catch (caught) {
      setError(true); setMessage(caught instanceof Error ? caught.message : "Reauthorization failed.");
    } finally { setBusy(false); }
  }

  async function disable(connectionId: string) {
    setBusy(true); setMessage(""); setError(false);
    try {
      await mutation(`/api/banking/connections/${connectionId}/disable`, "POST", {});
      setMessage("The bank feed was disabled. Existing observations and reconciliation evidence were retained.");
      router.refresh();
    } catch (caught) {
      setError(true); setMessage(caught instanceof Error ? caught.message : "Connection disable failed.");
    } finally { setBusy(false); }
  }

  async function mapAccount(accountId: string, selection: string) {
    const [legalEntityId, ledgerId, cashAccountCombinationId] = selection.split("|");
    if (!legalEntityId || !ledgerId || !cashAccountCombinationId) return;
    setBusy(true); setMessage(""); setError(false);
    try {
      await mutation(`/api/banking/accounts/${accountId}/mapping`, "PUT", { legalEntityId, ledgerId, cashAccountCombinationId });
      setMessage("The bank account was mapped to the selected company cash account.");
      router.refresh();
    } catch (caught) {
      setError(true); setMessage(caught instanceof Error ? caught.message : "Mapping failed.");
    } finally { setBusy(false); }
  }

  const canConnect = workspace.feedEnabled && workspace.permissions.connect && workspace.connections.length === 0;
  return <div className={styles.stack}>
    <Feedback message={message} error={error} />
    {canConnect && <section className="panel" aria-labelledby="simplefin-connect-title">
      <div className="panel-heading"><div><p className="eyebrow">Encrypted provider access</p><h2 id="simplefin-connect-title">Connect SimpleFIN</h2></div></div>
      <form className={styles.form} onSubmit={connect}>
        <div className={styles.grid}>
          <label><span>Connection name</span><input name="displayName" minLength={2} maxLength={100} required placeholder="Operating bank feed" /></label>
          <label><span>One-time setup token</span><input name="setupToken" type="password" minLength={20} maxLength={4096} required autoComplete="off" spellCheck={false} /></label>
        </div>
        <p className={styles.secretNote}>The one-time token is exchanged server-side. Only the resulting access credential is stored, encrypted with this organization&apos;s envelope key. Redirects and private-network endpoints are rejected.</p>
        <div className={styles.actions}><button className="primary-button" disabled={busy}>{busy ? "Connecting…" : "Connect securely"}</button></div>
      </form>
    </section>}
    {!workspace.connections.length && !canConnect && <div className={styles.callout}><strong>No external connection is active.</strong> {workspace.isDemo ? "Real bank credentials are intentionally disabled in the public nightly-reset demo." : workspace.feedEnabled ? "Your assigned role cannot manage bank credentials." : "This deployment has disabled bank feeds."}</div>}

    {workspace.connections.map((connection) => <section className="panel" key={connection.id} aria-labelledby={`connection-${connection.id}`}>
      <div className="panel-heading"><div><p className="eyebrow">{connection.provider}</p><h2 id={`connection-${connection.id}`}>{connection.displayName}</h2></div><StatusPill status={connection.status} /></div>
      <div className="account-detail-list">
        <div><span>Last successful sync</span><strong>{displayDate(connection.lastSyncedAt)}</strong></div>
        <div><span>Latest safe error code</span><strong>{connection.lastErrorCode ?? "None"}</strong></div>
      </div>
      {workspace.permissions.sync && <div className="panel-actions"><button className="primary-button" type="button" onClick={() => sync(connection.id)} disabled={busy || connection.status !== "ACTIVE"}>{busy ? "Working…" : "Sync last 90 days"}</button></div>}
      {workspace.permissions.connect && !workspace.isDemo && <form className={styles.form} onSubmit={(event) => reauthorize(event, connection.id)}>
        {workspace.feedEnabled && <label><span>{connection.status === "ACTIVE" ? "Replace credential with a new one-time setup token" : "Reauthorize with a new one-time setup token"}</span><input name="setupToken" type="password" minLength={20} maxLength={4096} required autoComplete="off" spellCheck={false} /></label>}
        <div className={styles.actions}>{workspace.feedEnabled && <button className="secondary-button" disabled={busy}>{connection.status === "ACTIVE" ? "Rotate encrypted credential" : "Reauthorize connection"}</button>}{connection.status !== "DISABLED" && <button className="secondary-button" type="button" disabled={busy} onClick={() => disable(connection.id)}>Disable feed</button>}</div>
        <small>Credential replacement and disabling require a recent authenticator step-up. The provider row, imported evidence, and append-only credential-version record are retained.</small>
      </form>}
    </section>)}

    {workspace.accounts.length > 0 && <section className="panel" aria-labelledby="bank-accounts-title">
      <div className="panel-heading"><div><p className="eyebrow">Explicit ledger mapping</p><h2 id="bank-accounts-title">Connected accounts</h2></div><span className="attention-count">{workspace.accounts.length}</span></div>
      <div className="table-scroll" tabIndex={0}>
        <table><thead><tr><th>Bank account</th><th>Currency / balance</th><th>Company cash account</th><th>Observations</th></tr></thead>
          <tbody>{workspace.accounts.map((account) => <tr key={account.id}>
            <td><strong>{account.displayName}</strong><small>{account.active ? "Active" : "Inactive"}</small></td>
            <td><strong>{account.latestBalance === null ? account.currencyCode : displayAmount(account.latestBalance, account.currencyCode)}</strong><small>{account.latestBalanceAt ? `As of ${displayDate(account.latestBalanceAt)}` : "No balance anchor"}</small></td>
            <td>{account.accountCombinationId ? <><strong>{account.entityCode} · {account.accountCode}</strong><small>{account.accountName}</small></> : workspace.permissions.reconcilePrepare ? <div className={styles.rowAction}><select aria-label={`Cash account for ${account.displayName}`} defaultValue="" onChange={(event) => mapAccount(account.id, event.target.value)} disabled={busy}><option value="">Choose a company cash account…</option>{workspace.cashAccounts.map((cash) => <option key={cash.id} value={`${cash.legalEntityId}|${cash.ledgerId}|${cash.id}`}>{cash.entityCode} · {cash.accountCode} · {cash.accountName} · ledger {cash.currencyCode}</option>)}</select></div> : <span>Not mapped</span>}</td>
            <td>{account.observationCount}</td>
          </tr>)}</tbody></table>
      </div>
    </section>}

    {workspace.observations.length > 0 && <section className="panel" aria-labelledby="bank-observations-title">
      <div className="panel-heading"><div><p className="eyebrow">Provider facts, separate from books</p><h2 id="bank-observations-title">Latest transaction observations</h2></div><span className="attention-count">{workspace.observations.length}</span></div>
      <div className="table-scroll" tabIndex={0}><table><thead><tr><th>Date</th><th>Bank account / payee</th><th>Status</th><th>Accounting state</th><th className={styles.amount}>Amount</th></tr></thead><tbody>
        {workspace.observations.map((observation) => <tr key={observation.versionId}><td>{observation.postedOn}</td><td><strong>{observation.payee}</strong><small>{observation.accountName}{observation.memo ? ` · ${observation.memo}` : ""}</small></td><td><StatusPill status={observation.status} /></td><td>{observation.matched ? "Matched" : observation.hasProposal ? "Rule suggestion" : "Unmatched"}</td><td className={styles.amount}>{displayAmount(observation.amount, observation.currencyCode)}</td></tr>)}
      </tbody></table></div>
    </section>}

    {workspace.syncRuns.length > 0 && <section className="panel" aria-labelledby="sync-history-title"><div className="panel-heading"><div><p className="eyebrow">Operational evidence</p><h2 id="sync-history-title">Sync history</h2></div></div><div className="table-scroll" tabIndex={0}><table><thead><tr><th>Started</th><th>Status</th><th>Accounts</th><th>Seen</th><th>New versions</th><th>Warnings / error</th></tr></thead><tbody>{workspace.syncRuns.map((run) => <tr key={run.id}><td>{displayDate(run.startedAt)}</td><td><StatusPill status={run.status} /></td><td>{run.accountCount}</td><td>{run.observationCount}</td><td>{run.versionCount}</td><td>{run.errorCode ?? run.warningCount}</td></tr>)}</tbody></table></div></section>}
  </div>;
}

function ReconciliationView({ workspace }: { workspace: BankingWorkspaceDto }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const mapped = workspace.accounts.filter((account) => account.accountCombinationId);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true); setMessage(""); setError(false);
    try {
      const result = await mutation("/api/banking/reconciliations", "POST", {
        externalAccountId: values.get("externalAccountId"),
        statementStartOn: values.get("statementStartOn"),
        statementEndOn: values.get("statementEndOn"),
        openingBalance: values.get("openingBalance"),
        closingBalance: values.get("closingBalance"),
        idempotencyKey: crypto.randomUUID(),
      }) as { reconciliationId: string };
      form.reset();
      setMessage("Draft reconciliation created. Imported observations remain separate from posted journal lines until explicitly matched and reviewed.");
      router.push(`/app/banking?view=reconciliation&reconciliation=${encodeURIComponent(result.reconciliationId)}`);
    } catch (caught) { setError(true); setMessage(caught instanceof Error ? caught.message : "Reconciliation creation failed."); }
    finally { setBusy(false); }
  }

  async function addMatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const active = workspace.activeReconciliation;
    if (!active) return;
    const values = new FormData(event.currentTarget);
    setBusy(true); setMessage(""); setError(false);
    try {
      await mutation(`/api/banking/reconciliations/${active.id}/matches`, "POST", {
        observationVersionId: values.get("observationVersionId"),
        journalLineId: values.get("journalLineId"),
        allocatedAmount: values.get("allocatedAmount"),
      });
      setMessage("Exact allocation added. The underlying provider observation and journal line remain immutable.");
      router.refresh();
    } catch (caught) { setError(true); setMessage(caught instanceof Error ? caught.message : "Match allocation failed."); }
    finally { setBusy(false); }
  }

  async function voidMatch(event: FormEvent<HTMLFormElement>, allocationId: string) {
    event.preventDefault();
    const active = workspace.activeReconciliation;
    if (!active) return;
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    setBusy(true); setMessage(""); setError(false);
    try {
      await mutation(`/api/banking/reconciliations/${active.id}/matches/${allocationId}/void`, "POST", { reason });
      setMessage("The allocation was voided with a permanent reason record.");
      router.refresh();
    } catch (caught) { setError(true); setMessage(caught instanceof Error ? caught.message : "Allocation void failed."); }
    finally { setBusy(false); }
  }

  async function transition(action: "SUBMIT" | "REVIEW" | "FINALIZE") {
    const active = workspace.activeReconciliation;
    if (!active) return;
    setBusy(true); setMessage(""); setError(false);
    try {
      await mutation(`/api/banking/reconciliations/${active.id}/transition`, "POST", { action });
      setMessage(action === "SUBMIT" ? "Reconciliation submitted for authorized review." : action === "REVIEW" ? "Authorized review recorded." : "Reconciliation finalized with its exact balance proof and allocation hash.");
      router.refresh();
    } catch (caught) { setError(true); setMessage(caught instanceof Error ? caught.message : "Reconciliation transition failed."); }
    finally { setBusy(false); }
  }

  async function voidReconciliation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const active = workspace.activeReconciliation;
    if (!active) return;
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    setBusy(true); setMessage(""); setError(false);
    try {
      await mutation(`/api/banking/reconciliations/${active.id}/transition`, "POST", { action: "VOID", reason });
      setMessage("The reconciliation was voided with permanent evidence. Its provider observations and posted journals were not changed.");
      router.refresh();
    } catch (caught) { setError(true); setMessage(caught instanceof Error ? caught.message : "Reconciliation void failed."); }
    finally { setBusy(false); }
  }

  return <div className={styles.stack}>
    <Feedback message={message} error={error} />
    <div className={styles.callout}><strong>Formal reconciliation boundary.</strong> Sessions snapshot a statement range, balances, company, ledger, and cash-account mapping. Creating a session never creates or posts a journal.</div>
    {workspace.permissions.reconcilePrepare && mapped.length > 0 && <section className="panel" aria-labelledby="new-reconciliation-title"><div className="panel-heading"><div><p className="eyebrow">Statement control</p><h2 id="new-reconciliation-title">New reconciliation</h2></div></div><form className={styles.form} onSubmit={create}><div className={styles.gridThree}>
      <label className={styles.full}><span>Mapped bank account</span><select name="externalAccountId" required defaultValue=""><option value="">Choose an account…</option>{mapped.map((account) => <option value={account.id} key={account.id}>{account.displayName} · {account.entityCode} · {account.currencyCode}</option>)}</select></label>
      <label><span>Statement start</span><input name="statementStartOn" type="date" required /></label><label><span>Statement end</span><input name="statementEndOn" type="date" required /></label>
      <label><span>Opening balance</span><input name="openingBalance" inputMode="decimal" pattern="-?\d+(\.\d{1,9})?" required /></label><label><span>Closing balance</span><input name="closingBalance" inputMode="decimal" pattern="-?\d+(\.\d{1,9})?" required /></label>
    </div><div className={styles.actions}><button className="primary-button" disabled={busy}>{busy ? "Creating…" : "Create draft reconciliation"}</button></div></form></section>}
    {!mapped.length && <div className={styles.callout}>Synchronize a connection and map at least one observed bank account before starting a reconciliation.</div>}
    <section className="panel" aria-labelledby="reconciliation-register-title"><div className="panel-heading"><div><p className="eyebrow">Preparer / reviewer record</p><h2 id="reconciliation-register-title">Reconciliation sessions</h2></div><span className="attention-count">{workspace.reconciliations.length}</span></div>
      {workspace.reconciliations.length ? <div className="table-scroll" tabIndex={0}><table><thead><tr><th>Bank account</th><th>Statement range</th><th>Opening</th><th>Closing</th><th>Matches</th><th>Status</th></tr></thead><tbody>{workspace.reconciliations.map((item) => <tr key={item.id} className={workspace.activeReconciliation?.id === item.id ? styles.selectedRow : undefined}><td><strong><a href={`/app/banking?view=reconciliation&reconciliation=${encodeURIComponent(item.id)}`}>{item.accountName}</a></strong><small>Created {displayDate(item.createdAt)}</small></td><td>{item.statementStartOn} – {item.statementEndOn}</td><td className={styles.amount}>{displayAmount(item.openingBalance, item.currencyCode)}</td><td className={styles.amount}>{displayAmount(item.closingBalance, item.currencyCode)}</td><td>{item.matchCount}</td><td><StatusPill status={item.status} />{item.voidReason && <small>{item.voidReason} · {displayDate(item.voidedAt)}</small>}</td></tr>)}</tbody></table></div> : <div className="empty-state"><strong>No reconciliation sessions</strong><p>Create a draft from a mapped account and statement range.</p></div>}
    </section>
    {workspace.activeReconciliation && <section className="panel" aria-labelledby="active-reconciliation-title">
      <div className="panel-heading"><div><p className="eyebrow">Exact balance proof</p><h2 id="active-reconciliation-title">Selected reconciliation</h2></div><StatusPill status={workspace.activeReconciliation.status} /></div>
      <div className={styles.form}>
        <div className={styles.proofGrid}>
          <div><span>Statement movement</span><strong>{displayAmount(workspace.activeReconciliation.statementMovement, workspace.activeReconciliation.currencyCode)}</strong></div>
          <div><span>{workspace.activeReconciliation.status === "FINALIZED" ? "Finalized bank-observation snapshot" : "Latest posted bank observations"}</span><strong>{displayAmount(workspace.activeReconciliation.observationTotal, workspace.activeReconciliation.currencyCode)}</strong></div>
          <div><span>Statement-to-bank difference</span><strong>{displayAmount(workspace.activeReconciliation.statementToBankDifference, workspace.activeReconciliation.currencyCode)}</strong></div>
          <div><span>Allocated posted cash-line movement</span><strong>{displayAmount(workspace.activeReconciliation.ledgerTotal, workspace.activeReconciliation.currencyCode)}</strong></div>
          <div><span>Unexplained difference</span><strong>{displayAmount(workspace.activeReconciliation.unexplainedDifference, workspace.activeReconciliation.currencyCode)}</strong></div>
          <div><span>Unresolved evidence</span><strong>{workspace.activeReconciliation.unmatchedObservationCount} bank observation(s) · {workspace.activeReconciliation.unmatchedLedgerLineCount} invalid allocation(s)</strong></div>
        </div>
        {workspace.activeReconciliation.status === "DRAFT" && workspace.permissions.reconcilePrepare && <form className={styles.form} onSubmit={addMatch}>
          <div className={styles.gridThree}>
            <label><span>Bank observation</span><select name="observationVersionId" required defaultValue=""><option value="">Choose unmatched observation…</option>{workspace.activeReconciliation.observations.filter((row) => row.remaining !== "0.000000000").map((row) => <option key={row.versionId} value={row.versionId}>{row.postedOn} · {row.payee} · {displayAmount(row.remaining, workspace.activeReconciliation!.currencyCode)} remaining</option>)}</select></label>
            <label><span>Posted cash line</span><select name="journalLineId" required defaultValue=""><option value="">Choose unmatched ledger line…</option>{workspace.activeReconciliation.ledgerLines.filter((row) => row.remaining !== "0.000000000").map((row) => <option key={row.lineId} value={row.lineId}>{row.accountingDate} · {row.journalLabel} · {displayAmount(row.remaining, workspace.activeReconciliation!.currencyCode)} remaining</option>)}</select></label>
            <label><span>Positive allocation amount</span><input name="allocatedAmount" inputMode="decimal" pattern="\d+(\.\d{1,9})?" required /></label>
          </div>
          <div className={styles.actions}><button className="secondary-button" disabled={busy}>Add exact allocation</button></div>
        </form>}
        <div className="table-scroll" tabIndex={0}><table><thead><tr><th>Date / bank observation</th><th className={styles.amount}>Amount</th><th className={styles.amount}>Allocated</th><th className={styles.amount}>Remaining</th></tr></thead><tbody>{workspace.activeReconciliation.observations.map((row) => <tr key={row.versionId}><td><strong>{row.payee}</strong><small>{row.postedOn}</small></td><td className={styles.amount}>{displayAmount(row.amount, workspace.activeReconciliation!.currencyCode)}</td><td className={styles.amount}>{displayAmount(row.allocated, workspace.activeReconciliation!.currencyCode)}</td><td className={styles.amount}>{displayAmount(row.remaining, workspace.activeReconciliation!.currencyCode)}</td></tr>)}</tbody></table></div>
        <div className="table-scroll" tabIndex={0}><table><thead><tr><th>Date / posted journal</th><th>Description</th><th className={styles.amount}>Amount</th><th className={styles.amount}>Allocated</th><th className={styles.amount}>Remaining</th></tr></thead><tbody>{workspace.activeReconciliation.ledgerLines.map((row) => <tr key={row.lineId}><td><strong>{row.journalLabel}</strong><small>{row.accountingDate}</small></td><td>{row.memo ?? row.description}</td><td className={styles.amount}>{displayAmount(row.amount, workspace.activeReconciliation!.currencyCode)}</td><td className={styles.amount}>{displayAmount(row.allocated, workspace.activeReconciliation!.currencyCode)}</td><td className={styles.amount}>{displayAmount(row.remaining, workspace.activeReconciliation!.currencyCode)}</td></tr>)}</tbody></table></div>
        {workspace.activeReconciliation.allocations.length > 0 && <div className="table-scroll" tabIndex={0}><table><thead><tr><th>Active allocation</th><th>Amount</th><th>Created</th><th>Correction</th></tr></thead><tbody>{workspace.activeReconciliation.allocations.map((row) => <tr key={row.id}><td><small>{row.observationVersionId}<br />{row.journalLineId}</small></td><td>{displayAmount(row.allocatedAmount, workspace.activeReconciliation!.currencyCode)}</td><td>{displayDate(row.createdAt)}</td><td>{workspace.activeReconciliation!.status === "DRAFT" && workspace.permissions.reconcilePrepare && <form className={styles.inlineForm} onSubmit={(event) => voidMatch(event, row.id)}><input name="reason" minLength={8} maxLength={500} required placeholder="Permanent void reason" /><button className="secondary-button" disabled={busy}>Void match</button></form>}</td></tr>)}</tbody></table></div>}
        {(workspace.permissions.reconcilePrepare || workspace.permissions.reconcileReview) && <div className={styles.actions}>
          {workspace.activeReconciliation.status === "DRAFT" && workspace.permissions.reconcilePrepare && <button className="primary-button" type="button" disabled={busy} onClick={() => transition("SUBMIT")}>Submit balanced proof</button>}
          {workspace.activeReconciliation.status === "SUBMITTED" && workspace.permissions.reconcileReview && <button className="primary-button" type="button" disabled={busy} onClick={() => transition("REVIEW")}>Record authorized review</button>}
          {workspace.activeReconciliation.status === "REVIEWED" && workspace.permissions.reconcileReview && <button className="primary-button" type="button" disabled={busy} onClick={() => transition("FINALIZE")}>Finalize immutable proof</button>}
          <small>Preparation and review are separate permissions. Owners, demo accountants, and explicitly dual-role users may hold both; private review and finalization also require a recent authenticator step-up.</small>
        </div>}
        {((workspace.activeReconciliation.status === "REVIEWED" && workspace.permissions.reconcileReview)
          || (workspace.activeReconciliation.status !== "REVIEWED" && workspace.permissions.reconcilePrepare))
          && workspace.activeReconciliation.status !== "FINALIZED" && workspace.activeReconciliation.status !== "VOIDED" && <form className={styles.inlineForm} onSubmit={voidReconciliation}>
          <input name="reason" minLength={8} maxLength={500} required placeholder="Permanent reconciliation void reason" />
          <button className="secondary-button" disabled={busy}>Void reconciliation</button>
          <small>Voiding is terminal, keeps all evidence, and requires recent authenticator verification in private accounts. A reviewed session requires review permission; draft or submitted sessions require preparation permission.</small>
        </form>}
        {workspace.activeReconciliation.status === "FINALIZED" && <p className="panel-note">Final proof hash: <code>{workspace.activeReconciliation.matchHash}</code></p>}
        {workspace.activeReconciliation.status === "FINALIZED" && <p className="panel-note">The totals and hash above are the stored immutable finalization snapshot. Later provider corrections remain separate append-only evidence.</p>}
        {workspace.activeReconciliation.status === "VOIDED" && <p className="panel-note">Voided {displayDate(workspace.activeReconciliation.voidedAt)} · {workspace.activeReconciliation.voidReason}</p>}
      </div>
    </section>}
  </div>;
}

function RulesView({ workspace }: { workspace: BankingWorkspaceDto }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const bankAccountNames = new Map(workspace.accounts.map((account) => [account.id, account.displayName]));
  const targetAccountNames = new Map(workspace.ruleTargetAccounts.map((account) => [
    account.id,
    `${account.entityCode} · ${account.accountCode} · ${account.accountName}`,
  ]));

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const text = String(values.get("descriptionContains") ?? "").trim();
    const minimum = String(values.get("minimumAbsoluteAmount") ?? "").trim();
    const maximum = String(values.get("maximumAbsoluteAmount") ?? "").trim();
    const mcc = String(values.get("merchantCategoryCode") ?? "").trim();
    const externalAccountId = String(values.get("externalAccountId") ?? "").trim();
    const target = String(values.get("targetAccountCombinationId") ?? "").trim();
    const memo = String(values.get("memo") ?? "").trim();
    setBusy(true); setMessage(""); setError(false);
    try {
      await mutation("/api/banking/rules", "POST", {
        name: values.get("name"), priority: Number(values.get("priority")), state: values.get("state"),
        condition: {
          direction: values.get("direction"),
          ...(text ? { descriptionContains: text } : {}),
          ...(minimum ? { minimumAbsoluteAmount: minimum } : {}),
          ...(maximum ? { maximumAbsoluteAmount: maximum } : {}),
          ...(mcc ? { merchantCategoryCode: mcc } : {}),
          ...(externalAccountId ? { externalAccountId } : {}),
        },
        action: {
          kind: values.get("kind"),
          ...(target ? { targetAccountCombinationId: target } : {}),
          ...(memo ? { memo } : {}),
        },
        idempotencyKey: crypto.randomUUID(),
      });
      form.reset(); setMessage("Encrypted rule saved. An active match can create an immutable manual-review suggestion only; it cannot create or post accounting."); router.refresh();
    } catch (caught) { setError(true); setMessage(caught instanceof Error ? caught.message : "Rule creation failed."); }
    finally { setBusy(false); }
  }

  async function versionState(ruleId: string, state: "ACTIVE" | "INACTIVE") {
    setBusy(true); setMessage(""); setError(false);
    try {
      await mutation(`/api/banking/rules/${ruleId}/state`, "POST", { state, idempotencyKey: crypto.randomUUID() });
      setMessage(`A new immutable ${state.toLowerCase()} rule version was created.`);
      router.refresh();
    } catch (caught) { setError(true); setMessage(caught instanceof Error ? caught.message : "Rule versioning failed."); }
    finally { setBusy(false); }
  }

  return <div className={styles.stack}>
    <Feedback message={message} error={error} />
    <div className={styles.callout}><strong>Manual-review suggestions only.</strong> Active rules evaluate newly observed bank versions in priority order and create an encrypted suggestion for a person to review. This release does not turn a suggestion into a GL, AR, AP, or transfer draft, and it never posts accounting.</div>
    {workspace.permissions.rules && <section className="panel" aria-labelledby="new-bank-rule-title"><div className="panel-heading"><div><p className="eyebrow">Deterministic conditions</p><h2 id="new-bank-rule-title">New categorization rule</h2></div></div><form className={styles.form} onSubmit={create}><div className={styles.gridThree}>
      <label><span>Name</span><input name="name" minLength={2} maxLength={100} required /></label><label><span>Priority</span><input name="priority" type="number" min={1} max={10000} defaultValue={100} required /></label><label><span>State</span><select name="state" defaultValue="DRAFT"><option value="DRAFT">Draft</option><option value="ACTIVE">Active</option></select></label>
      <label><span>Description contains</span><input name="descriptionContains" minLength={2} maxLength={100} /></label><label><span>Direction</span><select name="direction" defaultValue="ANY"><option value="ANY">Any</option><option value="INFLOW">Inflow</option><option value="OUTFLOW">Outflow</option></select></label><label><span>Bank account (required for an account suggestion)</span><select name="externalAccountId" defaultValue=""><option value="">All accounts · no account target</option>{workspace.accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label>
      <label><span>Minimum absolute amount</span><input name="minimumAbsoluteAmount" inputMode="decimal" pattern="\d+(\.\d{1,9})?" /></label><label><span>Maximum absolute amount</span><input name="maximumAbsoluteAmount" inputMode="decimal" pattern="\d+(\.\d{1,9})?" /></label><label><span>Merchant category code</span><input name="merchantCategoryCode" maxLength={16} /></label>
      <label><span>Suggestion kind</span><select name="kind" defaultValue="MANUAL_REVIEW"><option value="MANUAL_REVIEW">Manual review</option></select></label><label><span>Suggested offset account (optional)</span><select name="targetAccountCombinationId" defaultValue=""><option value="">Choose during review</option>{workspace.ruleTargetAccounts.map((account) => <option key={account.id} value={account.id}>{account.entityCode} · {account.accountCode} · {account.accountName} · {account.accountClass.toLowerCase()}</option>)}</select></label><label><span>Review memo</span><input name="memo" maxLength={500} /></label>
    </div><div className={styles.actions}><button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save encrypted rule"}</button></div></form></section>}
    <section className="panel" aria-labelledby="bank-rules-register-title"><div className="panel-heading"><div><p className="eyebrow">Encrypted rulebook</p><h2 id="bank-rules-register-title">Categorization rules</h2></div><span className="attention-count">{workspace.rules.length}</span></div>
      {workspace.rules.length ? <div className="table-scroll" tabIndex={0}><table><thead><tr><th>Priority / rule</th><th>Condition</th><th>Suggestion</th><th>Immutable state version</th></tr></thead><tbody>{workspace.rules.map((rule) => <tr key={rule.id}><td><strong>{rule.priority} · {rule.name}</strong><small>Version {rule.version} · created {displayDate(rule.createdAt)}</small></td><td>{rule.condition ? [rule.condition.externalAccountId && `account ${bankAccountNames.get(rule.condition.externalAccountId) ?? rule.condition.externalAccountId}`, rule.condition.descriptionContains && `contains “${rule.condition.descriptionContains}”`, rule.condition.direction !== "ANY" && rule.condition.direction.toLowerCase(), rule.condition.minimumAbsoluteAmount && `at least ${rule.condition.minimumAbsoluteAmount}`, rule.condition.maximumAbsoluteAmount && `at most ${rule.condition.maximumAbsoluteAmount}`, rule.condition.merchantCategoryCode && `MCC ${rule.condition.merchantCategoryCode}`].filter(Boolean).join(" · ") || "Bound condition" : "Encrypted data unavailable"}</td><td>{rule.action ? [rule.action.kind.replaceAll("_", " "), rule.action.targetAccountCombinationId && `account ${targetAccountNames.get(rule.action.targetAccountCombinationId) ?? rule.action.targetAccountCombinationId}`, rule.action.memo].filter(Boolean).join(" · ") : "Encrypted data unavailable"}</td><td><div className={styles.statusLine}><StatusPill status={rule.state} />{workspace.permissions.rules && rule.state !== "INACTIVE" && <button type="button" className="secondary-button" disabled={busy} onClick={() => versionState(rule.id, "INACTIVE")}>Create inactive version</button>}{workspace.permissions.rules && rule.state !== "ACTIVE" && <button type="button" className="secondary-button" disabled={busy} onClick={() => versionState(rule.id, "ACTIVE")}>Create active version</button>}</div></td></tr>)}</tbody></table></div> : <div className="empty-state"><strong>No categorization rules</strong><p>Add a draft rule, review it, then activate it when its conditions are safe.</p></div>}
      <p className="panel-note">Manual-review suggestions: {workspace.proposalCount}. Suggestions are immutable provider-derived evidence; no accept-to-draft workflow is advertised in this release.</p>
    </section>
    <section className="panel" aria-labelledby="bank-proposals-title"><div className="panel-heading"><div><p className="eyebrow">Human review queue</p><h2 id="bank-proposals-title">Categorization suggestions</h2></div><span className="attention-count">{workspace.proposalCount}</span></div>
      {workspace.proposals.length ? <div className="table-scroll" tabIndex={0}><table><thead><tr><th>Observed transaction</th><th>Rule</th><th>Suggested review</th><th>Created</th></tr></thead><tbody>{workspace.proposals.map((proposal) => <tr key={proposal.id}><td><strong>{proposal.payee}</strong><small>{proposal.postedOn} · {proposal.accountName} · {displayAmount(proposal.amount, proposal.currencyCode)}</small></td><td>{proposal.ruleName ?? "Rule unavailable"}</td><td>{proposal.action ? [proposal.action.targetAccountCombinationId ? targetAccountNames.get(proposal.action.targetAccountCombinationId) ?? proposal.action.targetAccountCombinationId : "Choose an account during review", proposal.action.memo].filter(Boolean).join(" · ") : "Encrypted suggestion unavailable"}</td><td>{displayDate(proposal.createdAt)}</td></tr>)}</tbody></table></div> : <div className="empty-state"><strong>No suggestions to review</strong><p>Active rules create immutable suggestions only when a newly imported observation matches.</p></div>}
    </section>
  </div>;
}

export function BankingWorkspace({ workspace, view }: { workspace: BankingWorkspaceDto; view: View }) {
  if (view === "reconciliation") return <ReconciliationView workspace={workspace} />;
  if (view === "rules") return <RulesView workspace={workspace} />;
  return <ConnectionView workspace={workspace} />;
}
