# Business Finlynq competitive fit-gap plan

Research date: 2026-08-28

Scope: Canadian and U.S. small-business accounting, with open-source and ERP comparators
Primary product assumption: Business Finlynq first serves small service businesses and accountant-led teams that value auditability, multicurrency, multi-entity books, and control of their deployment. Inventory-led businesses are a later expansion unless customer discovery changes that assumption.

## Executive recommendation

Business Finlynq has a stronger accounting-control foundation than its visible product breadth suggests. Its current advantage is not convenience; it is trustworthy accounting behavior:

- exact-decimal double entry;
- immutable posted history corrected through linked reversals;
- strong period states and posting permissions;
- organization isolation and envelope encryption;
- multi-entity, multicurrency, and segment-ready architecture;
- an AGPL deployment and data-ownership story.

The market leaders win the daily workflow. They guide setup, import old data, connect banks, present familiar money-in and money-out screens, let users search/filter/bulk-edit, deliver invoices, reconcile cash, and produce the standard reports without requiring accounting-system knowledge.

The recommended strategy is therefore:

1. Make Finlynq safe for a real organization.
2. Make setup and migration self-service.
3. Complete the reports and document workflows required to run and close a service business.
4. Add statement import and bank reconciliation before live bank feeds.
5. Make every high-frequency screen keyboard-fast, searchable, filterable, and drillable.
6. Add customer-facing delivery, payments, portals, controlled customization, and integrations.
7. Add inventory and other ERP modules only after the service-business core is excellent.

This is not a QuickBooks clone plan. It is a table-stakes plan that preserves Finlynq's differentiated control model.

## Research method and caveats

The comparison uses current first-party product pages, help centres, documentation, and source repositories. Capabilities vary by country, subscription tier, edition, add-on, and installed module. A filled circle means the capability is native and materially usable; a half circle means it is limited, plan/edition dependent, region dependent, or delivered by a tightly related add-on; a dash means it is not a core capability or was not found in the public first-party material reviewed.

The user's word “keyboards” is interpreted as keyboard shortcuts and high-speed keyboard data entry.

Products reviewed:

- Proprietary SaaS: QuickBooks Online Canada, Xero, Zoho Books Canada, and Sage Accounting Canada.
- Open-source or source-available: ERPNext, Odoo Community/Enterprise, Akaunting, and Dolibarr.
- Odoo is open-core: Community is open source and Enterprise adds licensed capabilities.
- Akaunting currently uses the Business Source License. Its current production-use limits mean it should be described as source-available rather than unrestricted open source, especially for an accounting SaaS.

## Current Business Finlynq baseline

The baseline is taken from [README.md](../README.md), [docs/roadmap.md](roadmap.md), the current route tree, [src/modules/registry.ts](../src/modules/registry.ts), [src/app/_components/workspace-shell.tsx](../src/app/_components/workspace-shell.tsx), and [src/app/_components/global-search.client.tsx](../src/app/_components/global-search.client.tsx).

### What exists

- Organization and multiple legal entities, each with a primary ledger.
- ASPE and U.S. GAAP non-public profiles.
- Fiscal periods with OPEN, ADJUSTMENT_ONLY, HARD_CLOSED, and SEALED states.
- A 13-field account-combination model: entity, account, subaccount, department, intercompany, and eight custom dimensions.
- Manual journal drafts, balanced posting, role-based posting policy, and linked reversals.
- Parties with customer and supplier roles.
- Service/non-stock sales invoices and supplier bills.
- Issue/post, open-item settlement allocation, void/reversal, and realized-FX behavior.
- Ontario HST and Washington sales-tax reference decisions and evidence snapshots.
- Trial balance and a compact accounting overview.
- Identity, invitations, roles, MFA, password recovery, encrypted master data, audit, outbox, RLS, backup, and operational controls, although real-account activation remains gated.
- Responsive workspace shell, accessible dialogs/navigation, and global search using Ctrl/Cmd + K.

### Current user-visible screens

- Marketing home, security, privacy, terms, login, invitation, password recovery, and recovery approval.
- Overview.
- General ledger journal register.
- New manual journal.
- Parties.
- Receivables invoices and recorded receipts.
- Payables bills and recorded payments.
- Tax determinations and manual-review exceptions.
- Trial balance and CSV export.
- Period-close readiness and transition preview.
- Legal-entity summary.
- AI and MCP boundary information.

### Important current limitations

- The public product is still a disposable demo; real-account writes are gated.
- Organization onboarding is an operator script, not an in-product workflow.
- There is no chart-of-accounts, dimensions, tax-registration, numbering, template, or module-configuration UI.
- Reports stop at overview metrics and trial balance.
- There is no bank statement import, feed, matching workspace, or reconciliation.
- Invoices and bills do not yet form a complete external document workflow with branded PDF/email delivery, attachments, online payment, recurring schedules, credit notes, statements, and dunning.
- There are no saved views, configurable columns, general bulk actions, report drill-down, transaction activity timeline, or broad import tools.
- Keyboard support is currently Ctrl/Cmd + K plus normal focus, Escape, and Tab behavior; transaction-entry shortcuts and grid navigation are absent.
- Public API, MCP, integrations, webhooks, portals, inventory, fixed assets, budgeting, projects/time, and payroll are absent or intentionally gated.

## Competitive landscape

| Product | Delivery and license | Strongest product lesson for Finlynq | Important constraint |
|---|---|---|---|
| QuickBooks Online Canada | Proprietary SaaS and mobile apps | Guided setup, familiar money-in/out workflows, bank automation, receipts, accountant ecosystem, plan-based growth | One company per subscription in normal QBO; advanced controls are tier-gated |
| Xero | Proprietary SaaS and mobile apps | Excellent bank reconciliation, clean business/accounting separation, accountant collaboration, keyboard-efficient invoice grid | Limited deep field/form customization; multi-entity usually means multiple organizations plus apps |
| Zoho Books Canada | Proprietary SaaS and mobile apps | Broadest SMB no-code customization: fields, modules, layouts, blueprints, buttons, reports, portals, and shortcuts | Depth can make administration complex; many advanced capabilities are plan dependent |
| Sage Accounting Canada | Proprietary SaaS and mobile app | Canada-specific tax, bilingual experience, bank rules, invoice capture, straightforward tiering | Less extensible and less operationally broad than full ERP products |
| ERPNext | GPL-3.0 open-source web ERP; self-hosted or managed cloud | Rich metadata-driven screens, imports, workflows, roles, customization, accounting/stock/assets/projects breadth | More implementation-heavy and ERP-like than a simple small-business product |
| Odoo 19 | Open-core: Community plus licensed Enterprise; self-hosted or hosted | Best-in-class modular surface, reusable views, reconciliation, report engine, command palette, and extension model | Full accounting and Studio capabilities differ by edition; implementation can be partner-heavy |
| Akaunting | BSL source-available; self-hosted or cloud | Lightweight accounting UI, multi-company dashboard, app-store extension story | Current BSL restricts larger production use and Accounting Service use; many capabilities come from apps |
| Dolibarr | GPL-3.0-or-later web ERP/CRM; self-hosted or hosted | Enable-only-what-you-need modules, broad operational coverage, permissions, extra fields, and ModuleBuilder | UI and keyboard experience are less cohesive than the leading SaaS products |

## Normalized module comparison

Legend: ● native/material; ◐ limited, plan/edition/region/add-on dependent; — not core or not found.

### Finance and operations

| Capability | Finlynq now | QBO | Xero | Zoho | Sage | ERPNext | Odoo | Akaunting | Dolibarr |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| General ledger and manual journals | ● | ● | ● | ● | ● | ● | ● | ◐ | ● |
| Customer invoicing and receivables | ◐ | ● | ● | ● | ● | ● | ● | ● | ● |
| Supplier bills and payables | ◐ | ● | ● | ● | ● | ● | ● | ● | ● |
| Credit/debit notes and refunds | — | ● | ● | ● | ● | ● | ● | ◐ | ● |
| Recurring transactions | — | ● | ● | ● | ◐ | ● | ● | ● | ◐ |
| Bank feeds/import and matching | — | ● | ● | ● | ● | ● | ● | ◐ | ● |
| Statement-period reconciliation | — | ● | ● | ● | ● | ● | ● | ● | ● |
| Sales-tax calculation | ◐ | ● | ● | ● | ● | ● | ● | ◐ | ● |
| Tax return preparation/filing workflow | — | ● | ● | ● | ● | ◐ | ● | ◐ | ◐ |
| Trial balance and GL detail | ◐ | ● | ● | ● | ● | ● | ● | ◐ | ● |
| P&L, balance sheet, cash flow | — | ● | ● | ● | ● | ● | ● | ◐ | ● |
| AR/AP aging and statements | — | ● | ● | ● | ● | ● | ● | ◐ | ● |
| Multicurrency | ● | ◐ | ◐ | ● | ◐ | ● | ● | ◐ | ● |
| Multiple legal entities in one accounting model | ● | — | ◐ | ◐ | — | ● | ● | ◐ | ◐ |
| Budgeting | — | ◐ | ● | ● | ◐ | ● | ● | ◐ | ◐ |
| Fixed assets and depreciation | — | ◐ | ● | ● | — | ● | ● | ◐ | ◐ |
| Projects, time, and job profitability | — | ◐ | ◐ | ● | ◐ | ● | ● | ◐ | ● |
| Basic inventory | — | ◐ | ◐ | ● | ◐ | ● | ● | ◐ | ● |
| Warehouse, purchasing, and fulfillment | — | ◐ | ◐ | ◐ | ◐ | ● | ● | ◐ | ● |
| Manufacturing and POS | — | — | — | ◐ | — | ● | ● | ◐ | ● |
| Payroll | — | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ |

Odoo cells reflect the full Odoo 19 suite documented across Community and Enterprise; edition comparison is required before treating any cell as a Community entitlement. Akaunting cells combine its base product and first-party app model. Proprietary-product cells likewise remain subject to country and subscription tier.

### Platform, setup, and customization

| Capability | Finlynq now | QBO | Xero | Zoho | Sage | ERPNext | Odoo | Akaunting | Dolibarr |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Guided company setup | — | ● | ● | ● | ● | ● | ● | ● | ◐ |
| Migration/import wizard | — | ● | ● | ● | ● | ● | ● | ◐ | ◐ |
| Customizable dashboard | — | ● | ◐ | ● | ◐ | ● | ● | ● | ● |
| Saved filters/views and configurable columns | — | ◐ | ● | ● | ◐ | ● | ● | ◐ | ● |
| Global search/command palette | ◐ | ● | ● | ● | ◐ | ● | ● | ◐ | ◐ |
| Document-entry keyboard workflow | — | ● | ● | ● | ◐ | ● | ● | — | ◐ |
| Report customization/builder | — | ● | ● | ● | ◐ | ● | ● | ◐ | ◐ |
| Custom fields and form layouts | — | ◐ | ◐ | ● | ◐ | ● | ● | ◐ | ● |
| Custom modules/objects | Architecture only | — | — | ● | — | ● | ● | ● | ● |
| Configurable approvals/workflows | Backend partial | ◐ | ◐ | ● | ◐ | ● | ● | ◐ | ◐ |
| Granular roles and permissions | Backend partial | ◐ | ◐ | ● | ◐ | ● | ● | ● | ● |
| Branded documents/templates | — | ● | ● | ● | ● | ● | ● | ● | ● |
| Attachments and receipt/bill capture | — | ● | ● | ● | ● | ● | ● | ◐ | ● |
| Customer/vendor portal | — | ◐ | ◐ | ● | ◐ | ● | ● | ● | ● |
| App ecosystem/public API | — | ● | ● | ● | ● | ● | ● | ● | ● |
| Self-hosting and source control | ● | — | — | — | — | ● | ◐ | ◐ | ● |
| Immutable posted corrections and strong period controls | ● | ◐ | ◐ | ◐ | ◐ | ◐ | ● | ◐ | ◐ |

## Screens and data interaction patterns

### QuickBooks Online

Primary surfaces:

- Home dashboard with Home, Cash flow, Planner, setup checklist, tasks, and configurable widgets.
- Banking/transactions, sales, expenses, customers, suppliers, payroll, projects, taxes, reports, accounting, apps, and settings.
- Form-first creation for invoices, bills, receipts, expenses, journals, estimates, purchase orders, and payments.
- Register and report views with filters, exports, drill-down, and accountant tools.

Data interaction:

- Bank feeds, categorization suggestions, rules, receipt capture, matching, and reconciliation reduce entry.
- Quick-create shortcuts and dashboard shortcuts lead directly to high-frequency tasks.
- Lists support search, filters, batch operations in higher plans, and Excel sync in Advanced.
- Reports support filters, columns, saved custom reports, management-report packages, and Advanced report building.

Keyboard:

- The current product release advertises more than 50 shortcuts across banking, lists, forms, and reports.
- Ctrl + Alt + ? on Windows or Cmd + Option + ? on macOS opens the guide.
- Date fields accept +/−, T for today, and period-boundary keys.
- Amount fields evaluate arithmetic after Tab.
- Tab/Shift + Tab navigate forms, Alt + S saves, and arrows navigate registers.

Setup:

- Dashboard checklist, company settings, users, bank connection, data import, sales tax, payments, payroll, invoice customization, and reports.
- Imports include customers, suppliers, inventory, and chart of accounts.

Customization:

- Company preferences, invoice appearance, terms, reminders, products/services, classes, locations, tags/custom fields, dashboards, reports, budgets, roles, and Advanced workflows.
- Custom roles and report builder are strongest in Advanced; ordinary QBO is not a custom application platform.

### Xero

Primary surfaces:

- Homepage dashboard.
- Business/Sales, Purchases, Contacts, Accounting/Bank accounts, Reporting, Payroll, Projects, Files, and organization settings.
- Invoice/bill list, document form, bank reconciliation, cash-coding grid, report, and file-library screens.

Data interaction:

- Bank statement lines are matched or used to create transactions in a focused reconciliation screen.
- Lists, reports, and invoice line grids support filters, direct editing, drag-to-fill, and keyboard selection/fill.
- Contacts aggregate invoices, bills, and payments.
- Report packs and layouts support reusable accountant workflows.

Keyboard:

- Press / anywhere to search; shortcut letters open bank accounts, bills, contacts, invoices, reports, settings, and new documents.
- Invoice actions have Alt/Option and Ctrl/Cmd combinations.
- In line-item navigation mode, Tab then Escape enters grid navigation; arrows move, Enter edits, and Shift plus arrows selects cells for fill.

Setup:

- Organization details, financial settings, chart of accounts, conversion date and balances, taxes, bank feeds, users, apps, and imports.
- Conversion supports chart of accounts, contacts, invoices, bills, and fixed assets.

Customization:

- Chart of accounts, tracking categories, branding themes, report layouts/templates, budgets, roles, and app integrations.
- Tracking supports four categories total but only two active at once; user roles are useful but not fully custom.

### Zoho Books

Primary surfaces:

- Dashboard, Items, Banking, Sales, Purchases, Time Tracking, Accountant, Reports, Documents, integrations, settings, and customer/vendor portals.
- Standard list, form, detail, dashboard, report, document, and portal screens.

Data interaction:

- Advanced search, configurable list columns/views, imports/exports, bulk actions, recurring transactions, transaction approvals, attachments, and bank matching/reconciliation.
- Zia provides conversational queries and links to actions.
- Reporting tags and report customization support divisional analysis.

Keyboard:

- Shift + ? opens the guide; shortcuts can be customized.
- / searches, Option + / opens advanced search, and Shift-letter/number combinations navigate modules.
- Chorded C + key shortcuts create invoices, journals, quotes, credit notes, bills, expenses, accounts, customers, vendors, and payments.
- Option + S saves and sends; module actions cover import/export/select all.

Setup:

- Organization profile, chart of accounts, banks, opening balances, users/roles, preferences, taxes, contacts, items, projects/time, purchases, sales, and journals in a documented migration order.

Customization:

- Custom fields, layouts, templates, reports, reporting tags, roles, workflows, webhooks, custom buttons, Deluge actions, validation rules, blueprints, related lists, portals, and full custom modules with records and tables.
- This is the strongest direct SMB benchmark for safe no-code customization.

### Sage Accounting Canada

Primary surfaces:

- Dashboard/cash flow, sales, purchases, contacts, products/services, banking/reconciliation, tax, reports, and settings.
- Mobile capture and approval are available for selected tasks.

Data interaction:

- Bank feeds/import, rules, categorization, matching, reconciliation, receipt and purchase-invoice capture, and list/report filters.
- Sales documents include quotes, invoices, credit notes, statements, remittance and delivery documents depending on plan.

Keyboard:

- No comprehensive current first-party cloud shortcut guide was located in this review. Treat Sage Accounting as primarily menu/form driven; do not infer that it has no shortcuts.

Setup:

- Company details, contacts, products/services, chart of accounts, bank data, opening balances, invoices, tax, and imports from spreadsheets or prior systems.

Customization:

- Invoice templates, logos/colors/fonts/wording, dashboards, reports, bank rules, analysis dimensions, users, and marketplace integrations.
- Accounting Plus adds inventory and multicurrency; payroll is a separate synchronized product.

### ERPNext

Primary surfaces:

- Frappe Desk with persistent sidebar and module Workspaces.
- Generated List, Form, Grid, Report, Tree, Calendar, Gantt, and Kanban views.
- Form sidebars contain assignments, sharing, attachments, tags, comments, emails, edits, and a timeline.
- Workspaces combine dashboards, shortcuts, masters, transactions, settings, and reports.

Data interaction:

- List filters, sort, paging, tags, bulk import/update, configurable grids, assignments, comments, attachments, report builder, and drillable source documents.
- Operational documents submit into accounting, stock, payment, and asset ledgers.

Keyboard:

- Shift + ? shows shortcuts.
- Ctrl/Cmd + K or G opens the Awesomebar for pages, reports, document types, and records.
- Ctrl/Cmd + S triggers the primary action; Alt reveals menu shortcuts.

Setup:

- Company/country/currency/fiscal year, chart of accounts, cost centers/dimensions, defaults, taxes, payment terms, banks, users, workflows, opening balances, outstanding invoices, and data import.

Customization:

- Customize Form, custom fields, DocTypes, field permission levels, roles, workflows, workspaces, reports, print formats, scripts, and full custom apps.

### Odoo 19

Primary surfaces:

- App launcher, per-app dashboards, and shared List, Form, Kanban, Calendar, Activity, Pivot, Graph, Cohort, and other views.
- Accounting Dashboard, invoice/bill forms, Bank Matching, report drill-down, chatter, activities, and configuration.

Data interaction:

- Search/filter/group/favorites, bulk actions, imports/exports, inline list edits where enabled, chatter/activities, bank matching models, pivot/graph exploration, and report drill-down.

Keyboard:

- Hold Alt on Windows/Linux or Ctrl on macOS to reveal available element shortcuts.
- Alt + C creates, Alt + S saves, Alt + Q searches, and Ctrl/Cmd + K opens the command palette.
- In the palette, / searches menus/apps, @ users, # channels, and ? knowledge.

Setup:

- Fiscal localization, chart of accounts, currencies, journals, fiscal positions, taxes, payment terms, products, contacts, default accounts, opening invoices/bills, inventory, trial balance, and bank/credit-card transactions.

Customization:

- Developer modules and XML/Python extensions in Community.
- Studio in Enterprise adds models, fields, forms, views, automations, buttons, properties, and exportable customization modules.
- Accounting reports can be built from lines, expressions, columns, grouping, variants, and custom computation.

### Akaunting

Primary surfaces:

- Dashboard(s), Items, Sales, Purchases, HR, Banking, Calendar, Reports, Apps, and Settings.
- List/form pages and an app marketplace.

Data interaction:

- Dashboard widgets, recurring transactions, imports/exports, customer portal, accounts, transfers, reconciliation, and app-provided features.

Keyboard:

- No current comprehensive first-party shortcut guide was located. The official interface material is mainly menu/list/form driven.

Setup:

- Wizard for company, language, currency, location, logo, tax number, fiscal year, address, industry, and recommended apps.

Customization:

- Multiple dashboards/widgets, email and invoice templates, roles, languages, and modular apps.
- Many advanced functions, including double entry, projects, payroll, bank feeds, and CRM, are installed apps rather than one coherent core.

### Dolibarr

Primary surfaces:

- Home dashboard boxes, horizontal module menu, vertical task menu, List/Create screens, and object cards with tabs.
- Modules appear only when enabled.

Data interaction:

- Consistent create/list/card pattern, filters, document tabs, permissions, extra fields, exports, and module-specific reports.

Keyboard:

- Core documentation does not present a unified current shortcut system. Accountancy has some quick navigation, and an external My Shortcuts module adds configurable Alt/Ctrl and search-code shortcuts.

Setup:

- Company/organization, enabled modules, module-specific settings, users/groups/permissions, display/menu handlers, dictionaries, security, and accounting configuration.

Customization:

- Module activation, dashboard boxes, menu managers, extra fields, document templates, permissions, themes, external DoliStore modules, and the included developer-focused ModuleBuilder.

## Fit-gap assessment

### Areas where Finlynq already fits or exceeds

| Area | Assessment | Product implication |
|---|---|---|
| Ledger correctness | Exceeds many SMB products | Keep one posting service, exact decimals, immutable posting, and reversal lineage non-negotiable |
| Period control | Differentiated | Surface it as a simple Close & review workflow instead of exposing only technical states |
| Multi-entity and account dimensions | Strong architectural fit | Turn the existing model into guided configuration and comparative reporting |
| Multicurrency provenance | Strong foundation | Add rate management, revaluation, and user-friendly explanations |
| Tenant security and encrypted master data | Differentiated | Complete activation and make security visible but not burdensome |
| Open deployment and data ownership | Differentiated | Add reliable export, backup portability, and upgrade documentation |
| Module isolation | Strong architecture | Add modules slowly; quality and upgrade safety matter more than module count |

### Critical gaps blocking a good accounting service

| Gap | Why the market treats it as table stakes | Priority |
|---|---|:---:|
| Real-account activation and production guardrails | A correct demo is not a usable bookkeeping service | Gate |
| Guided setup and migration | Every direct competitor helps establish company, books, tax, banks, users, and opening data | P0 |
| P&L, balance sheet, GL detail, cash flow, aging, and statements | Users cannot manage or close a business from trial balance alone | P0 |
| Bank import, matching, and reconciliation | Bank-to-books is the daily centre of modern SMB accounting | P0 |
| Complete invoice/bill document lifecycle | Users need PDF/email delivery, credits, recurring documents, attachments, and external status | P0 |
| Fast list and entry interaction | Current forms work, but lack saved views, bulk actions, grid navigation, and shortcut depth | P0 |
| Self-service accounting configuration | Operator scripts cannot be the product setup surface | P0 |
| Tax return preparation and ledger reconciliation | Transaction tax decisions do not complete the compliance job | P1 |

### High-value gaps after table stakes

- Bank feeds through an approved aggregator after file import and reconciliation are proven.
- Branded templates, email delivery history, reminders, statements, and customer/vendor portals.
- Online invoice payment and controlled supplier-payment integration.
- Receipt/bill capture with attachments first, OCR second.
- Approval inbox, audit explorer, posting-policy administration, and close work queues.
- Safe custom fields, saved views, dashboards, report layouts, and controlled workflow rules.
- Public API, OAuth service principals, webhooks, import connectors, and integration marketplace.

### Later or conditional gaps

- Inventory and fulfillment: advance only when the chosen first customer segment truly tracks stock.
- Fixed assets and budgeting: valuable after the financial statement layer exists.
- Projects/time: advance for professional-services customers if job profitability is part of the initial wedge.
- Payroll: integrate posted payroll summaries first; do not build gross-to-net tax calculation without a separate compliance program.
- Manufacturing/POS: later vertical modules.
- MCP/AI: read and draft only after the same API, roles, reports, and workflows are production proven.

## Priority model

The recommended score uses:

- 30% user value and task frequency;
- 25% market table-stakes pressure;
- 20% trust, compliance, and close impact;
- 15% leverage of existing Finlynq architecture;
- 10% dependency-unlocking and strategic differentiation.

The production activation work is a gate and is not ranked against feature work.

| Rank | Initiative | Score / 100 | Recommended release |
|---:|---|---:|---|
| 1 | Bank statement import, deterministic matching, and reconciliation | 96 | R2 |
| 2 | Core financial statements, GL drill-down, aging, and statements | 95 | R1 |
| 3 | Guided organization setup, migration, opening balances, and tie-out | 94 | R1 |
| 4 | Invoice/bill completeness: credits, recurring, PDF/email, numbering, templates | 93 | R1 |
| 5 | High-speed lists, grids, saved views, global actions, and shortcuts | 88 | R1 |
| 6 | Tax returns and tax-to-ledger reconciliation | 87 | R2 |
| 7 | Attachments, document inbox, and receipt/bill capture | 84 | R1/R3 |
| 8 | Approval inbox, posting-policy UI, audit explorer, and close centre | 82 | R1/R2 |
| 9 | Online invoice payments, reminders, and customer/vendor portals | 81 | R3 |
| 10 | Public API, OAuth, webhooks, and priority integrations | 73 | R4 |
| 11 | Safe custom fields, layouts, dashboards, reports, and workflows | 72 | R4 |
| 12 | Inventory, purchasing, fulfillment, and COGS | 64 | R5 or earlier only for an inventory ICP |
| 13 | Projects, time, and job profitability | 58 | R5 or earlier for a services ICP |
| 14 | Fixed assets and budgeting | 56 | R5 |
| 15 | Payroll journal import/integration | 53 | R5 |
| 16 | MCP and governed AI read/draft access | 48 | R4 after public API |
| 17 | Full payroll calculation and filing | 25 | Separate compliance program; not committed |

## Recommended release plan

Release names are outcome gates, not calendar estimates.

### G0 — Safe production

Objective: one real organization can operate safely.

Deliver:

- Complete every open blocker in [docs/plan/codex-implementation-plan.md](plan/codex-implementation-plan.md).
- Activate invitation, MFA, recovery, per-organization writes, email delivery, key custody, monitoring, backups, restore, and deployment acceptance.
- Add production support surfaces: service status, request ID, operator diagnostics, and user-visible data export.

Exit:

- A production-like invite-to-recovery scenario passes end to end.
- A restored organization retains readable accounting and encrypted master data.
- Write activation can be granted to one organization without opening every organization.

### R1 — Complete bookkeeping core

Objective: a small service business can migrate, invoice, enter bills, keep books, and produce an accountant-ready month-end package.

Deliver:

- Guided setup wizard and go-live checklist.
- Chart-of-accounts templates, dimensions, entities, fiscal year, currencies, tax registration, payment terms, numbering, and opening balances.
- Migration centre with file mapping, preview, validation, error download, idempotent retry, and trial-balance tie-out.
- P&L, balance sheet, GL detail, trial balance by period/entity/dimension, AR/AP aging, and customer/supplier statements.
- Credit/debit notes, recurring journals/invoices/bills, document attachments, branded PDF/email delivery, and delivery history.
- Approval inbox, posting-policy administration, audit explorer, and complete reversal UX.
- Standard list/detail screens with filters, sort, configurable columns, saved views, bulk actions, export, activity timeline, and source drill-down.
- Keyboard system and transaction-entry grid described below.

Exit:

- A new organization can reach a balanced opening trial balance without operator database work.
- Every financial-statement number drills to account, journal, and source document.
- A customer invoice and supplier bill complete their full draft-to-post-to-settlement-to-correction lifecycle.

### R2 — Bank-to-close

Objective: users can reconcile cash, prepare tax, and close a period.

Deliver:

- CSV, OFX/QFX, and CAMT.053 bank imports with encrypted raw evidence and deduplication.
- Deterministic matching suggestions, rules, transfer handling, and confirmed draft creation.
- Statement-period reconciliation with opening/closing assertions, adjustments, sign-off snapshot, and unreconciled warnings.
- Cash position and short-horizon forecast.
- Effective-dated production tax packs, tax returns, tax-to-GL reconciliation, manual filing reference, and tax period locking.
- Close centre combining bank, AR/AP, tax, FX, approvals, and period blockers.

Exit:

- Reconciliation proves statement ending balance equals cleared-book balance plus explained differences.
- Tax return lines reconcile to posted tax snapshots and control accounts.
- A period cannot close while configured hard blockers remain.

### R3 — Customer and supplier service

Objective: Finlynq handles the operational experience around the books.

Deliver:

- Quotes, sales orders where justified, purchase orders, and source-document lineage.
- Customer and vendor portals.
- Automated invoice reminders, statements, dunning, and delivery status.
- Online invoice payment and controlled payable/payment integrations.
- Document inbox, email-in documents, receipt capture, OCR-assisted draft extraction, duplicate detection, and mobile approval/capture.
- Bank aggregator connection only after R2 reconciliation is stable.

Exit:

- The invoice-to-payment experience works without a separate invoicing product.
- OCR and bank suggestions never post without the configured human/policy path.

### R4 — Controlled extensibility

Objective: organizations can adapt Finlynq without forking the accounting core.

Deliver:

- Safe custom fields on masters and draft/source documents.
- Field visibility, labels, required rules, configurable columns, saved views, dashboard cards, document templates, and versioned report layouts.
- Controlled approval and notification rules; no arbitrary tenant code in the hosted product.
- Public API, OAuth service principals, idempotency, webhooks, scopes, revocation, and integration logs.
- Priority connectors selected from customer demand.
- MCP and AI read/draft tools on the same services and scopes; never posting, approval, period reopen, role change, recovery, payment execution, or deletion.

Exit:

- Customization changes are versioned, audited, testable, exportable, and do not rewrite posted history.
- API and MCP abuse tests prove organization and scope isolation.

### R5 — Modular expansion

Objective: expand only into validated customer segments.

Default sequence:

1. Inventory/item/location/valuation and purchase-receipt-bill matching.
2. Fixed assets and budgeting.
3. Projects/time/job profitability if service customers demand it; move ahead of inventory for a service-only wedge.
4. Payroll summary import and liability reconciliation.
5. Consolidation and secondary ledgers.
6. Manufacturing, POS, and other vertical modules.

## Recommended information architecture

The current navigation is accounting-model centric. Small-business users think in jobs, while accountants need expert surfaces. Preserve the unified party and ledger model underneath, but make navigation role-adaptive.

### Owner/bookkeeper navigation

- Home
- Sales
  - Customers
  - Quotes
  - Invoices
  - Payments
  - Statements
- Purchases
  - Suppliers
  - Bills
  - Expenses
  - Payments
- Banking
  - Transactions
  - Reconciliation
  - Cash
- Accounting
  - Chart of accounts
  - Journal entries
  - Close & review
  - Tax
- Reports
- Settings

### Accountant/admin additions

- Entities and ledgers.
- Dimensions and account combinations.
- Posting policies and approvals.
- Audit explorer.
- Tax packs and returns.
- Roles, recovery, integrations, API, module administration, data import/export, and templates.

“Parties” should remain the domain model but appear to ordinary users as Customers and Suppliers. “AI & MCP” should move out of primary navigation until it is functional, then live under Connections/Automation.

## Standard screen model

Every master and transaction module should reuse five predictable screens:

1. Workspace/overview: attention items, key totals, tasks, and quick create.
2. List/work queue: filters, search, sort, saved views, columns, bulk actions, import/export.
3. Form/composer: header, line grid, totals, evidence, validation, and explicit primary action.
4. Detail/activity: status, source lineage, allocations, journal impact, attachments, comments, delivery, and audit timeline.
5. Report/reconciliation: parameters, totals, drill-down, saved layout, export, and sign-off where applicable.

This reusable model is more valuable than designing a different interaction for every module.

## Keyboard and high-speed entry specification

Keyboard shortcuts should never fire while a user is typing unless they are field-specific. Every command must also have a visible control and accessible name.

### Global

| Shortcut | Action |
|---|---|
| Ctrl/Cmd + K | Command palette across pages, records, reports, settings, and create actions |
| Shift + ? | Show the contextual shortcut guide |
| / | Focus list/report search when focus is not in an editor |
| G then H/S/P/B/A/R | Go to Home, Sales, Purchases, Banking, Accounting, or Reports |
| C then I/B/J/R/P | Create invoice, bill, journal, receipt/payment, or party |
| Escape | Close a dialog/panel or return focus to its trigger |

### Forms

| Shortcut | Action |
|---|---|
| Alt/Option + S | Save draft |
| Ctrl/Cmd + Enter | Execute the visible primary action; require confirmation for issue/post/void |
| Alt/Option + Shift + N | Save draft and start another |
| T in an empty date field | Today |
| + / − in a date field | Next/previous day |
| Ctrl/Cmd + D | Duplicate the current draft or selected draft line |

### Line grids

- Tab/Shift + Tab moves forward/backward through editable cells.
- Arrow keys move between cells in navigation mode.
- Enter starts editing or commits the cell.
- Escape cancels the cell edit without leaving the form.
- Alt/Option + Up/Down reorders a draft line.
- Delete removes only a draft line and offers Undo.
- Paste from a spreadsheet fills a selected rectangular range after validation preview.
- Totals and validation update without shifting focus.

## Setup and migration blueprint

Offer Quick setup for ordinary users and Advanced setup for accountants.

1. Business profile: name, address, industry preset, language, time zone.
2. Legal entities: country/region, accounting profile, functional currency, fiscal year.
3. Tax: registrations, filing frequency, reporting method, jurisdiction packs.
4. Books: chart template/import, control accounts, dimensions, numbering, opening period.
5. Customers, suppliers, items/services, payment terms, and tax defaults.
6. Opening data: trial balance, outstanding invoices/bills, bank opening balances, and optional history.
7. Banking: create accounts, import a sample statement, and confirm mapping.
8. Documents: logo, invoice/bill/statement templates, email sender, payment instructions.
9. Team: invite users, assign roles, configure approval/posting policy, require MFA.
10. Validation: run setup checks, post test transactions in a rehearsal period, tie out reports.
11. Go live: lock the conversion date, enable organization writes, and retain a signed setup summary.

The migration centre must never silently overwrite. It should show source rows, mapped targets, validation results, duplicates, accounting impact, and a reversible batch before posting.

## Customization model

Finlynq should compete with Zoho/ERPNext/Odoo on safe configuration, not arbitrary scripting.

### Tier 1 — Safe configuration

- Module enablement.
- Labels, field visibility, required rules, and non-accounting custom fields.
- Document numbering, terms, tax defaults, templates, email wording, and branding.
- Dimensions, saved views, columns, filters, dashboards, report layouts, and favorites.
- Roles, posting policies, approval steps, and notification preferences.

### Tier 2 — Controlled automation

- Conditions over trusted fields and states.
- Actions limited to assign, notify, request approval, create a draft, set an allowed draft field, call an approved webhook, or schedule a reminder.
- Simulation and test mode before activation.
- Version, actor, effective date, run log, retry, and disable switch.

### Tier 3 — Extensions

- Signed/versioned module manifests.
- Public API and webhooks.
- Isolated connector workers.
- Exportable configuration bundles.
- No extension can bypass RLS, posting, period, encryption, audit, or idempotency services.

## Metrics and acceptance signals

Track these by release and customer cohort:

- Time from signup to balanced opening trial balance.
- Percentage of setups completed without operator intervention.
- Migration rows accepted, rejected, retried, and tied out.
- Time and error rate for a 20-line invoice, bill, and journal.
- Percentage of high-frequency tasks completed without a mouse.
- Bank lines imported, deduplicated, suggested, confirmed, and manually created.
- Reconciliation throughput and unexplained-difference count.
- Days to close and blockers by category.
- Invoice delivery, view, reminder, and payment cycle time.
- Report drill-down success and export usage.
- Reversal/correction rate by source workflow.
- Support requests per activated organization.

Targets should be baselined with design partners rather than guessed in advance.

## Product decisions to preserve

- Do not allow users, integrations, or AI to edit posted accounting history.
- Do not make a bank or OCR suggestion equivalent to a posted transaction.
- Do not build full payroll merely for checklist parity.
- Do not expose arbitrary tenant scripts in a hosted financial system.
- Do not lead with module count while setup, reporting, banking, and daily interaction are incomplete.
- Do not hide accounting impact: every source document and report total must trace to journals and evidence.
- Do not force accounting vocabulary on every user; provide task-oriented navigation with an accountant mode.

## How this changes the existing implementation plan

The current [Codex implementation plan](plan/codex-implementation-plan.md) is technically strong and should remain the engineering control document. Product research suggests four sequencing changes:

1. Add guided setup, migration, templates, configuration UI, and high-speed interaction to the front of Phase 2.
2. Split reporting from the rest of Phase 2 and ship it immediately after activation.
3. Pull file-based banking and reconciliation forward so it can progress alongside production tax rather than waiting behind all tax work.
4. Put PDF/email delivery, document attachments, credits, recurring transactions, and customer statements into the first complete-bookkeeping release.

Inventory, full customization, public API/MCP, and payroll remain later, but now have explicit customer-value gates.

The resulting release gates, work packages, dependencies, acceptance tests, and rollout controls are defined in the [product implementation work order](plan/product-implementation-work-order-2026-08.md).

## Primary sources

### QuickBooks Online

- [QuickBooks Online Canada plans and features](https://quickbooks.intuit.com/ca/pricing/)
- [QuickBooks Online Advanced Canada](https://quickbooks.intuit.com/ca/online/advanced/)
- [Get started with QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-ca/help-article/product-setup/get-started-quickbooks-online/L9viDdPJB_CA_en_CA)
- [QuickBooks Online keyboard shortcuts](https://quickbooks.intuit.com/learn-support/en-us/help-article/product-setup/keyboard-shortcuts-quickbooks-online/L49aUqVh2_US_en_US)
- [What's new in QuickBooks Online, including the 2026 shortcut expansion](https://quickbooks.intuit.com/learn-support/en-us/help-article/intuit-subscriptions/new-quickbooks-online/L66q5XLC5_US_en_US)
- [Custom fields and transaction tracking](https://quickbooks.intuit.com/learn-support/en-ca/help-article/class-list/tag-transactions-quickbooks-online/L7x3G0aLv_CA_en_CA)
- [Custom reports in QuickBooks Online Advanced](https://quickbooks.intuit.com/learn-support/en-ca/help-article/report-management/create-custom-reports-quickbooks-online-advanced/L27SwFuwz_CA_en_CA)
- [Custom roles in QuickBooks Online Advanced](https://quickbooks.intuit.com/learn-support/en-ca/help-article/access-permissions/add-manage-custom-roles-quickbooks-online-advanced/L8Ugph7xl_CA_en_CA)

### Xero

- [All Xero features](https://www.xero.com/ca/accounting-software/all-features/)
- [Xero tips and keyboard shortcuts](https://central.xero.com/s/article/Tips-and-shortcuts)
- [Start using Xero](https://central.xero.com/s/article/Start-using-Xero-UK)
- [Tracking categories](https://central.xero.com/s/article/Set-up-tracking-categories)
- [User roles and permissions](https://central.xero.com/s/article/User-roles-and-permissions-in-Xero-Business-edition-US)
- [Report templates and layouts](https://central.xero.com/s/article/Edit-a-report-template)

### Zoho Books

- [Zoho Books accounting features](https://www.zoho.com/ca/books/accounting-software-features/)
- [How Zoho Books works](https://www.zoho.com/ca/books/help/getting-started/zoho-books.html)
- [Zoho Books keyboard shortcuts](https://www.zoho.com/ca/books/help/getting-started/keyboard-shortcuts.html)
- [Zoho Books custom modules](https://www.zoho.com/ca/books/help/custom-modules/)
- [Custom module preferences and blueprints](https://www.zoho.com/ca/books/help/custom-modules/preferences.html)
- [Migration/import order](https://www.zoho.com/ca/books/kb/general/migration-import-data.html)

### Sage Accounting Canada

- [Sage Accounting Canada](https://www.sage.com/en-ca/sage-business-cloud/accounting/)
- [Sage Accounting plans](https://www.sage.com/en-ca/sage-business-cloud/accounting/pricing/)
- [Sage bank reconciliation](https://www.sage.com/en-ca/sage-business-cloud/accounting/features/bank-reconciliation/)
- [Sage invoice templates](https://www.sage.com/en-ca/sage-business-cloud/accounting/features/invoice-templates/)

### ERPNext

- [ERPNext source and GPL license](https://github.com/frappe/erpnext)
- [ERPNext accounting introduction](https://docs.frappe.io/erpnext/accounting-introduction)
- [Frappe Desk views and interaction](https://docs.frappe.io/framework/user/en/desk)
- [Frappe keyboard shortcuts](https://docs.frappe.io/framework/keyboard-shortcuts)
- [ERPNext workspaces](https://docs.frappe.io/erpnext/workspace)
- [ERPNext form customization](https://docs.frappe.io/erpnext/customize-form)
- [ERPNext role permissions](https://docs.frappe.io/erpnext/role-based-permissions)
- [ERPNext workflows](https://docs.frappe.io/erpnext/workflows)

### Odoo

- [Odoo Community and Enterprise editions](https://www.odoo.com/page/editions)
- [Odoo 19 user applications](https://www.odoo.com/documentation/19.0/applications.html)
- [Odoo Accounting and Invoicing](https://www.odoo.com/documentation/19.0/applications/finance/accounting.html)
- [Odoo Accounting setup](https://www.odoo.com/documentation/19.0/applications/finance/accounting/get_started.html)
- [Odoo keyboard shortcuts](https://www.odoo.com/documentation/19.0/applications/essentials/keyboard_shortcuts.html)
- [Odoo Studio views](https://www.odoo.com/documentation/19.0/applications/studio/views.html)
- [Odoo models, modules, and apps](https://www.odoo.com/documentation/19.0/applications/studio/models_modules_apps.html)
- [Odoo Community source](https://github.com/odoo/odoo)

### Akaunting

- [Akaunting features](https://akaunting.com/features)
- [Akaunting navigation and modules](https://akaunting.com/hc/docs/the-user-interface/navigation-menu/)
- [Akaunting setup](https://akaunting.com/hc/docs/getting-started/setting-up-akaunting-cloud/)
- [Akaunting source repository](https://github.com/akaunting/akaunting)
- [Akaunting Business Source License terms](https://github.com/akaunting/akaunting/blob/master/LICENSE.txt)

### Dolibarr

- [Dolibarr source and GPL license](https://github.com/Dolibarr/dolibarr)
- [What Dolibarr does](https://wiki.dolibarr.org/index.php/What_Dolibarr_Does)
- [Dolibarr usage and screen pattern](https://wiki.dolibarr.org/index.php/General_information_on_usage)
- [Dolibarr first setup](https://wiki.dolibarr.org/index.php?title=First_setup)
- [Dolibarr users and permissions](https://wiki.dolibarr.org/index.php/Module_Users)
- [Dolibarr ModuleBuilder](https://wiki.dolibarr.org/index.php/Module_ModuleBuilder)
