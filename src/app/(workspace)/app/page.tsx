import Link from "next/link";
import { EntityRegister } from "../../_components/entity-register";
import { formatMoney } from "@/kernel/money";
import {
  loadAccountingOverview,
  loadEntitySummaries,
} from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { currentWorkspaceEntityContext } from "@/modules/workspace/entity-context";
import { DemoNotice, EmptyState, PageHeader } from "../../_components/ui";
import styles from "@/app/_components/workspace-navigation.module.css";

function displayAmount(currency: string, amount: string): string {
  return formatMoney(amount, currency);
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[] }>;
}) {
  const principal = await requireWorkspacePrincipal("/app");
  const [parameters, entityContext] = await Promise.all([
    searchParams,
    currentWorkspaceEntityContext(principal),
  ]);
  const requestedScope = Array.isArray(parameters.scope) ? parameters.scope[0] : parameters.scope;
  const showAllEntities = requestedScope === "all" || !entityContext.selectedEntity;
  const selectedEntityId = showAllEntities ? null : entityContext.selectedEntity?.id ?? null;
  const overview = await loadAccountingOverview(principal, selectedEntityId);
  const entitySummaries = overview.access.ledger ? await loadEntitySummaries(principal) : [];
  const entities = showAllEntities
    ? entitySummaries
    : entitySummaries.filter((entity) => entity.id === selectedEntityId);
  const scopeLabel = showAllEntities
    ? "All entities"
    : `${entityContext.selectedEntity?.code} · ${entityContext.selectedEntity?.displayName}`;
  const metrics = [
    ...(overview.access.receivables ? [{
      label: "Open receivables",
      values: overview.openReceivables.length
        ? overview.openReceivables.map(({ currency, amount }) => displayAmount(currency, amount))
        : ["No open balance"],
      note: "Customer open items, kept separate by transaction currency",
      tone: "blue",
    }] : []),
    ...(overview.access.payables ? [{
      label: "Open payables",
      values: overview.openPayables.length
        ? overview.openPayables.map(({ currency, amount }) => displayAmount(currency, amount))
        : ["No open balance"],
      note: "Supplier open items, kept separate by transaction currency",
      tone: "amber",
    }] : []),
    ...(overview.access.ledger ? [{
      label: "Journal workflow",
      values: [`${overview.postedJournalCount} posted`, `${overview.unpostedJournalCount} unposted`],
      note: "Draft, submitted, and approved journals remain unposted",
      tone: "purple",
    }] : []),
    ...(overview.access.tax ? [{
      label: "Tax review",
      values: [
        `${overview.taxDecisionCount} recorded`,
        `${overview.manualReviewTaxCount} review`,
      ],
      note: overview.manualReviewTaxCount ? "Manual review remains required" : "No tax review exceptions",
      tone: "green",
    }] : []),
  ];

  return (
    <div className="page-content">
      <PageHeader
        eyebrow={`${principal.organizationName} · ${scopeLabel}`}
        title="Accounting overview"
        description={`Live balances and workflow counts for ${showAllEntities ? "the full organization" : "the working entity"}. Currencies are never combined implicitly.`}
        actions={overview.access.ledger ? (
          <>
            <a
              className="secondary-button"
              href="/app/reports/trial-balance.csv"
            >
              Export trial balance
            </a>
            <Link className="primary-button" href="/app/journals/new">＋ New journal</Link>
          </>
        ) : undefined}
      />

      {principal.sessionMode === "demo" && (
        <DemoNotice>
          This is one shared writable demo company. Every demo visitor sees the same changes until the seeded setup is restored nightly. <Link href="/signup">Create a permanent business account</Link>.
        </DemoNotice>
      )}

      {entityContext.selectedEntity && entityContext.options.length > 1 && (
        <nav className="form-actions" aria-label="Dashboard entity scope">
          <span className="subtle-label">Dashboard scope</span>
          <Link
            className={showAllEntities ? "secondary-button compact-button" : "primary-button compact-button"}
            href="/app"
            aria-current={showAllEntities ? undefined : "page"}
          >
            {entityContext.selectedEntity.code} · Working entity
          </Link>
          <Link
            className={showAllEntities ? "primary-button compact-button" : "secondary-button compact-button"}
            href="/app?scope=all"
            aria-current={showAllEntities ? "page" : undefined}
          >
            All entities
          </Link>
          <span className="subtle-label">
            {showAllEntities
              ? "Organization totals keep every currency in a separate row."
              : `Using ${entityContext.selectedEntity.functionalCurrency} for ${entityContext.selectedEntity.displayName}.`}
          </span>
        </nav>
      )}

      {overview.access.tax && overview.manualReviewTaxCount > 0 && (
        <section className="attention-banner" aria-labelledby="attention-title">
          <span className="attention-icon" aria-hidden="true">!</span>
          <div>
            <strong id="attention-title">Tax decisions require review</strong>
            <p>Unsupported tax facts are held for review instead of silently defaulting to zero.</p>
          </div>
          <Link href="/app/tax?status=review">Review exceptions <span aria-hidden="true">→</span></Link>
        </section>
      )}

      <section aria-labelledby="position-title">
        <div className="section-heading">
          <div><p className="eyebrow">Position</p><h2 id="position-title">At a glance</h2></div>
          <span className="subtle-label">{scopeLabel} · currencies shown separately</span>
        </div>
        {metrics.length ? <div className="metric-grid">
          {metrics.map((metric) => (
            <article className="metric-card" key={metric.label}>
              <span className={`metric-signal signal-${metric.tone}`} aria-hidden="true" />
              <p>{metric.label}</p>
              <div>{metric.values.map((value) => <strong key={value}>{value}</strong>)}</div>
              <span>{metric.note}</span>
            </article>
          ))}
        </div> : (
          <EmptyState title="No accounting summary permissions">
            Ask an organization administrator to assign access to the ledger, receivables, payables, or tax workspace.
          </EmptyState>
        )}
      </section>

      {metrics.length > 0 && <section aria-labelledby="workspace-shortcuts-title">
        <h2 id="workspace-shortcuts-title" className="sr-only">Common tasks</h2>
        <div className={styles.quickLinks}>
          {overview.access.receivables && <Link href="/app/receivables/invoices">Review customer invoices <span aria-hidden="true">→</span></Link>}
          {overview.access.payables && <Link href="/app/payables/bills">Review supplier bills <span aria-hidden="true">→</span></Link>}
          {overview.access.ledger && <Link href="/app/reports">Run an accounting report <span aria-hidden="true">→</span></Link>}
          {overview.access.tax && <Link href="/app/tax">Prepare a tax return <span aria-hidden="true">→</span></Link>}
        </div>
      </section>}

      {overview.access.ledger && <section aria-labelledby="entities-title">
        <div className="section-heading">
          <div><p className="eyebrow">Legal entities</p><h2 id="entities-title">Primary ledgers</h2></div>
          <Link className="text-link" href="/app/entities">View entities</Link>
        </div>
        {entities.length ? (
          <EntityRegister entities={entities} />
        ) : (
          <EmptyState title="No legal entities configured">
            Add an active legal entity and primary ledger to begin accounting.
          </EmptyState>
        )}
      </section>}

      {overview.access.ledger && <div className="compact-summary panel">
        <p><strong>Corrections preserve history.</strong> Posted source entries are corrected through their owning module.</p>
        <Link className="text-link" href="/app/journals">View journals</Link>
        <Link className="text-link" href="/app/controls/period-close">Open period controls</Link>
      </div>}
    </div>
  );
}
export const metadata = { title: "Accounting overview" };
