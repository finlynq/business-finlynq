# Tax filing revisions and comparison refresh

Saving a mapping appends an immutable mapping version. It does **not** activate that version for filing calculations. Workpapers use the exact template and mapping pinned by the configuration effective at the reporting period end. If a newer mapping is effective for that period, the old configuration is blocked with `CONFIGURATION_MAPPING_OUTDATED`, before calculation or database insertion. Activate a reviewed configuration revision first. A future-dated mapping does not invalidate an earlier reporting period.

The mapping revision guard runs at transaction commit, after all mapping lines exist. It excludes its own inserted revision from the competing-successor check. All predecessor scope, version, effective-date, line coverage and immutable-history checks remain enforced. Migration 0079 changes only that guard; it grants no permissions and changes no existing mappings or filings.

## Access diagnosis

The UI and both connector tax workspace reads return separate capabilities for mapping, preparation, configuration, canonical selection and lifecycle changes. Connector responses report the deployed tool name, required membership permission and OAuth scope, confirmation requirement, and a specific reason:

| Reason | Required action |
| --- | --- |
| `PERMISSION_REQUIRED` | Ask an already authorized organization owner to perform the review, or have an administrator review membership and fixed roles in `/app/settings`. Reconnecting does not add membership permissions. |
| `OAUTH_SCOPE_REQUIRED` | Reconnect with the indicated `mcp:daily:write` or `mcp:setup:write` consent. |
| `CONNECTION_MODE_RESTRICTED` | Review Daily/Setup write mode and the individual tool override in `/app/settings/mcp`. |
| `UNSUPPORTED_DEPLOYED_CAPABILITY` | Have the service administrator check the deployed revision and catalog header, then refresh the connector catalog. |
| `WRITES_DISABLED` | Use an organization/session whose writes have been enabled. |

Configuration requires `tax.filing.configuration.manage`; canonical selection and lifecycle changes independently require `tax.filing.canonical.manage`. The configuration/canonical/lifecycle services use advisory transaction fences rather than row locks that require UPDATE grants on immutable tables. The current OWNER template contains these permissions. BOOKKEEPER_MAKER and ACCOUNTANT_APPROVER do not. Migration 0073 registered the new permissions without backfilling existing role grants, so an older owner role may differ from the current provisioning template. Check actual active membership grants, not the role label. Do not assign a broader role, modify a custom role, or backfill permissions automatically as a workaround. An existing authorized administrator must explicitly review any permission change. This release preserves those grants and database permission guards.

To diagnose an older deployment, inspect the `x-finlynq-mcp-catalog-revision` header and tools/list, then compare the returned capabilities to the connection's scopes, modes, overrides and current membership. A legacy workspace response without `capabilityVersion` predates these diagnostics; absence alone does not prove a missing membership grant. No customer-specific role grants were changed by this fix.

## Reviewed correction flow

1. Read the exact template and current mapping. Preserve its existing lines and add missing income/expense accounts to `wp_book_net_income`; retain reviewed balance treatments and multipliers. Preview and save with exact expected versions, a later effective date, a permanent reason and a unique idempotency key.
2. Separately review and activate a configuration revision with the exact mapping ID, template, entity/ledger, registration, effective dates and expected configuration version. The connector tool is `finlynq_daily_save_tax_filing_configuration`; audit and replay protections apply.
3. In Filing history, open **Refresh / reconcile**. Review copied reported values, manual inputs and the original source reference. An empty field remains absent; an explicitly entered zero remains zero. Legacy comparisons did not persist manual-input presence: nonzero manual calculations are recovered and flagged for review, while ambiguous old zeros are left blank.
4. Review current posted book net income and unmapped account amounts. Missing income/expense accounts with posted activity block calculation, including accounts whose debits and credits net to zero. Unmapped accounts without activity are displayed for review. Do not use Schedule 1 adjustments to hide missing ledger expenses.
5. Create the new immutable comparison. Snapshot time, template/mapping/configuration versions, original comparison ID, manual inputs and a fingerprint of posted journals are preserved. The prior workpaper and canonical selection remain unchanged. Canonical selection is a separate authorized, reasoned action.

The read-only connector preflight is `finlynq_daily_preview_tax_filing_readiness`. Workspace history provides refresh inputs and freshness reasons. Create a reviewed new `HISTORICAL_IMPORT` through `finlynq_daily_create_tax_filing_workpaper`, including `refreshFromFilingId`, exact configuration, original scope/period/reference and reviewed values. Repeating the same idempotency key and payload returns the committed workpaper; a changed payload conflicts.

Freshness is evaluated against current posted activity for the original ledger and period, and the effective configuration/mapping. Comparison snapshots and balances are read using repeatable-read transactions. Older workpapers without a ledger fingerprint are explicitly marked for refresh rather than assumed current. These operations create workpaper evidence only: no journal posting, tax-authority transmission or payment occurs.
