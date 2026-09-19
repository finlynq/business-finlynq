# Business Finlynq UI review

Reviewer: Astra (`gpt-6-astra`, extra-high effort). Date: 2026-09-18.

## Scope and approach

Reviewed all 36 existing `page.tsx` routes, the workspace/auth/marketing shells, shared navigation and search, report controls, and the page-specific accounting, tax, banking, assets, document, party, AR/AP, account-security and organization forms. This is a source-led product and accessibility audit; runtime browser coverage is recorded separately in verification below. Routes in the workspace route group continue to use their existing `/app/...` public URLs through the configured rewrites. API/export/OAuth route handlers are not additional product pages.

The app already has a useful visual vocabulary: navy navigation, teal actions, explicit entity/currency context, tables for accounting evidence, and permission-aware actions. The main problem is information organization. Daily tasks and administration share a flat sidebar, useful destinations are hidden behind other pages, and long setup forms compete with transactional work. A few descriptions also contradict the current implementation.

## Recommended information architecture and implemented priorities

1. **Make every core workspace discoverable.** Group the sidebar into Daily work, Review & close, and Administration. Expose Documents and Legal entities. Give Reports its own landing page with four purpose-led report cards. Include all reports, accounting configuration, account security and the connection guide in global search. Use the most specific matching route so a settings subpage has only one active sidebar item.
2. **Separate working views from setup and reference material.** Tax gets URL-driven Prepare return, Filing history, Templates & rules, Transaction tax and Exceptions views. Preparation and account mappings have separate accessible local tabs. Accounting configuration gets Entities & ledgers, Chart of accounts, Reporting hierarchies, Currencies & rates and Tax registrations tabs. Preserve existing hash links and keep local panels mounted so draft form values survive switching tabs.
3. **Use one navigation language.** Settings, banking and reports use the same visual treatment for route links and the same current-page indicator. Route links remain ordinary links; local sections use the keyboard tab pattern with arrow/Home/End navigation and associated panels. Mobile navigation retains focus return and now locks background scrolling.
4. **Improve scanability without changing accounting meaning.** Standardize workspace heading typography, section spacing, panel titles and form grids; retain tabular amounts, currency boundaries and scrollable evidence tables. Put accounting change reasons before the affected controls. Keep the asset register and reconciliation visible while moving exceptional creation/lifecycle forms into named disclosures. Add entity search and tax mapping field search. Put report dimension controls in an expandable group that opens automatically when filters are active.
5. **Make product copy accurate and task-oriented.** State that demo changes are shared, not private. Replace the obsolete “future/no public MCP endpoint” story with actual connection controls. Distinguish navigation search from live transaction search. Explain denied module access as a permissions issue rather than claiming the existing module has not been implemented. Give each rendered workspace route its own document title and remove the document page's nested main landmark.

New page: `/app/reports`. Additional task pages are unnecessary for this release: existing report routes and URL/hash views provide direct destinations without duplicating forms, loaders or security checks. No invented cash-flow charts, due-date aggregates or audit timelines were added because those would need new data contracts.

## Every existing page

| Public route | Finding and recommendation | Implemented disposition |
| --- | --- | --- |
| `/` | Demo is described as isolated and MCP as future-only; available banking/assets are absent from capability cards. | Correct shared-demo and current AI connection descriptions; add banking/assets cards and link the connection guide. Retain the existing responsive marketing structure and primary CTAs. |
| `/privacy` | Long-form policy is already narrow, sectioned and linked to related policies. | Retain content and layout; expose policy links consistently from authentication pages. No legal text rewritten. |
| `/security` | Existing sections explain identity, accounting and demo boundaries. | Retain the distinct public policy page and its disclosures; improve entry points through auth/workspace footer. |
| `/terms` | Preview terms have a clear intro and separate sections. | Retain content; add consistent access from authentication flows. |
| `/login` | Focused auth task already supports enabled/disabled/error/session-switch states. | Retain form, routing and security behavior; shared auth footer supplies Privacy/Terms/Security. |
| `/signup` | Microsoft/password branches and verification gating need a focused form, not workspace navigation. | Retain progressive signup controls; shared auth footer improvement. |
| `/complete-signup` | Identity confirmation and authenticator enrollment are a distinct security step. | Retain workflow; shared auth footer improvement. |
| `/accept-invitation` | Password/enrollment and unavailable states already share a coherent shell. | Retain workflow; shared auth footer improvement. |
| `/forgot-password` | Recovery should keep its neutral response and obvious return path. | Retain form and neutral copy; shared auth footer improvement. |
| `/reset-password` | Password replacement has security implications and should stay separate. | Retain form; shared auth footer improvement. |
| `/app` | Balances are visible but offer few next-task entry points. | Add permission-aware common-task links to invoices, bills, reports and tax; preserve entity scope and separate currencies; shared hierarchy and title improvements. |
| `/app/journals` | Header leads with implementation details; dense register already supports search, paging and actions. | Rewrite the introduction around finding/reviewing entries; retain posting evidence and source ownership; shared hierarchy and title improvements. |
| `/app/journals/new` | Balanced journal form and return path are appropriate. | Retain form and validations; shared hierarchy and unique title. |
| `/app/journals/[journalId]` | Header, immutable summary and line evidence have a sound hierarchy. | Retain evidence and source correction link; shared hierarchy and title. |
| `/app/parties` | “Unified master data” is technical; customer/supplier purpose should lead. | Use customer/supplier language; retain exact encrypted-name search, party relationships, corrections and paging; title/hierarchy improvements. |
| `/app/receivables/invoices` | Good register/filter/detail workflow, but demo copy wrongly promises privacy. | Correct demo description and task-oriented header; retain invoice/receipt/void controls and existing register filters. |
| `/app/payables/bills` | Good register/detail/settlement workflow, but demo copy wrongly promises privacy. | Correct demo description and task-oriented header; retain payment methods, evidence and source correction controls. |
| `/app/banking` | Existing route views are useful but their active state is visual-only; description is technical. | Shared accessible route tabs with `aria-current`; task-oriented introduction; retain connections, observations, reconciliation and rules. |
| `/app/assets` | Lifecycle form precedes the register; all creation/configuration forms are expanded. | Name and collapse lifecycle/new-record/category forms; leave register, reconciliation and schedules available; add responsive form grids and clearer introduction. |
| `/app/tax` | Preparation, large mapping forms, template reference, history and transaction evidence create a very long mixed-purpose page. | Five URL views, local preparation/mapping tabs, mapping field search, and visible guidance when required mappings are missing. Preserve `?status=review` and existing data/commands. |
| `/app/reports/trial-balance` | One report is used as the entire Reports destination; other reports are poorly discoverable. | Keep explicit filters/CSV/totals; share route tabs including All reports; accurate sidebar active state and page title. |
| `/app/reports/balance-sheet` | Sidebar does not identify this as Reports; report content and currency boundaries are sound. | Shared report tabs and correct sidebar state; preserve statements/hierarchies/totals and add title. |
| `/app/reports/profit-and-loss` | Same report-navigation problem. | Shared report tabs and correct sidebar state; preserve fiscal/date scope, net income and title. |
| `/app/reports/account-inquiry` | Useful drill-through exists but is hidden from top-level discovery. | Add search/hub entry and shared tabs; retain journal links, FX evidence and running balance; unique title. |
| `/app/controls/period-close` | Stateful close and period creation are correctly grouped with warnings. | Move discovery under Review & close; retain creation, close, step-up, warnings and the read-only demo branch; shared hierarchy/title. |
| `/app/entities` | Useful cards but no sidebar destination or visible search despite a query loader. | Expose in Administration and settings navigation; add visible entity search and clear-filter action; retain add-entity link and cards. |
| `/app/settings` | Organization administration is also used as a loose gateway to unrelated settings. | Shared settings navigation identifies organization/team versus accounting/documents/AI/entities; retain profile, member access and trusted-browser controls; improve multiline panel headings. |
| `/app/settings/accounting` | Five large setup areas form a long scroll; global change reason appears last. | Five mounted, hash-addressable keyboard tabs; put audit reason before controls; keep MFA feedback visible outside panels; shared settings navigation. |
| `/app/settings/documents` | Daily inbox is hidden in settings and renders a nested main landmark; repeat connection setup competes with existing documents. | Expose Documents in Daily work, add settings sibling navigation, use one main landmark and collapse connection setup when storage already exists; retain inbox/upload permissions. |
| `/app/settings/mcp` | Working AI integration has no obvious path to its public guide. | Shared settings navigation and prominent Connection guide action; retain connection permissions/approvals/MFA handling. |
| `/app/automation` | Legacy page incorrectly claims MCP is unavailable/future-only and shows obsolete scope names. | Replace stale claims with a current access overview and links to actual settings/docs. Keep the existing route and authentication. |
| `/app/account` | Profile, authentication, enrollment and trusted browsers are correctly separated. | Retain security sections and deep links; add global search discovery, shared hierarchy and title. |
| `/app/platform` | Aggregate-only administrative context is correctly distinct from tenant records. | Retain access gate, aggregate cards and return action; shared hierarchy/title. Do not expose it in ordinary navigation. |
| `/app/security/recovery/approve` | High-consequence approval should stay a focused protected task. | Retain its dedicated form and step-up requirement; shared hierarchy/title. |
| `/app/mcp/authorize` | Redirect-only continuation, not a content page. | Retain parameter-preserving redirect exactly; no tab, navigation or disclosure added. |
| `/docs/remote-mcp` | Detailed useful guide has no branded frame and weak section discovery/readability. | Add brand/back link, topic navigation, section anchors, restrained content width, readable spacing and document title. |

## Shared component decisions

The workspace shell, desktop/mobile navigation, global search, page headings, route navigation, report controls, accounting settings, tax preparation, asset forms and auth shell were the main reuse points. Existing mutation feedback, entity context, account menu, register pagination, party forms, AR/AP details, MFA enrollment, recovery approval, banking operations and document permissions remain the authorities for their interactions. Layout changes do not invent capability based on presentation; server authorization and command validation remain unchanged.

The report hub is a catalogue, not a dashboard with fabricated metrics. No unlike currencies are combined. Tax returns remain workpapers rather than transmitted filings. Collapsed asset forms and inactive accounting/tax panels do not submit automatically. Existing API routes, idempotency, hash checks, permissions, MFA, encryption and database schemas are unchanged.

## Verification

- Focused Vitest coverage checks report-hub authentication/destinations, boundary-aware active navigation, single selection on nested settings routes, route-link semantics and mounted section-panel semantics.
- Added read-only Playwright scenarios for report/settings navigation, accounting deep links and keyboard behavior, retained tax form values, mobile width and mobile focus return.
- Initial verification: TypeScript and full-repository ESLint passed; 51 focused tests passed across 13 suites, including isolation, accounting overview, organization settings, journal detail, auth entry points, tax templates/client, MCP settings, party directory, platform administration, entity defaults and the new navigation suite. The default Turbopack production build made no progress beyond compilation startup in the sandbox and was stopped; the parent task is handling a supported Webpack build and full-suite verification.
- Browser tests need a running configured application with demo entry enabled; source review is not a substitute for authenticated browser verification. Database integration tests were skipped locally because the three test database URLs are absent; these changes do not modify schema or database contracts.

## Follow-on recommendations requiring separate product/data work

These are longer-term design opportunities rather than incomplete portions of the changes above. They should not be represented by decorative UI without the underlying capability.

| Opportunity | Why it is not part of this UI change | Evidence needed before implementation |
| --- | --- | --- |
| A consolidated “Needs attention” page | Current modules expose different readiness/exception models; combining them without a scoped contract can misstate urgency or leak counts. | Permission-aware counts, entity/date scope, drill-through targets and consistent status definitions. |
| Real transaction results in global search | Real encrypted records use module-specific authorized searches, while global search currently holds only static routes and seeded demo examples. | Search API with encrypted-name semantics, paging, authorization and rate limits. |
| User-selected columns and saved report views | Table layouts should respond to accounting roles and repeated use, but there is no persisted preference contract yet. | Usage observations, a preference model and accessibility behavior for hidden/reordered columns. |
| A searchable audit activity page | Immutable evidence exists in individual workflows, but no cross-module audit reader is exposed as a product feature. | Authorized audit query, redaction rules, pagination and safe source links. |
| A close checklist based on live reconciliations | The non-writable demo preview has seeded readiness checks; displaying those as real live evidence would be misleading. | A real readiness service covering reconciliations, tax review, unposted items and period scope. |
| Full permission-filtered navigation | Page/action authorization is already enforced, but hiding module links consistently needs a single shell capability DTO. | Shared read-capability contract and coverage for every fixed role; hidden links must never become a substitute for authorization. |

The recommended next usability study is a short task-based review with an owner and an accountant: find an overdue bill, trace a report balance to a journal, change an exchange rate, and prepare a mapped tax workpaper. Use observed failures to prioritize these follow-ons.
