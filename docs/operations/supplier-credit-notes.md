# Supplier credit notes

In Payables, choose **New credit note**. Enter positive credit amounts, the
supplier, original reference and dates, expense/asset and tax mappings, currency,
and any reviewed source-tax evidence. An original posted bill is optional; when
selected it must belong to the same supplier, ledger, entity and currency.
Attach source evidence through the normal invoice evidence workflow before
posting. Draft edits create new immutable versions.

Posting a CAD 100 credit plus CAD 13 recoverable HST debits AP 113, credits the
expense 100 and credits recoverable tax 13. Saved purchase/tax facts and totals
are negative; open credit balances are positive magnitudes marked as credits.
Supplier dashboard totals subtract unapplied credits. Existing positive bills
and signed adjustment lines keep their existing behavior.

Use **Apply supplier credit to a bill** to consume a full or partial amount.
The credit and bill must share supplier, ledger, currency and AP control.
Excess credit remains available. Application debits the bill's AP carrying amount
and credits the credit's AP carrying amount, posting only their difference to
realized FX. It does not repeat purchase/tax recognition. Applications use sorted
open-item locks, exact-decimal balances, idempotency and database guards; the
final application consumes any carrying-rounding residue.

Void an application from the register to reverse its exact two allocations and
journal. Reverse all applications before voiding a credit or affected bill.
Normal period, permission, audit-reason and approval rules apply. Historical
open-item queries reconstruct applications and reversals through `asOfDate`.

MCP tools:

- `finlynq_daily_create_supplier_credit_note`, `edit_supplier_credit_note`,
  `issue_supplier_credit_note` and `void_supplier_credit_note` (each with the
  same `finlynq_daily_` prefix).
- `finlynq_daily_list_payable_open_items`: `documentKind` is `BILL` (default),
  `CREDIT` or `ALL`. Credit amounts are positive, with `documentKind: CREDIT`.
- `finlynq_daily_apply_supplier_credit`: use exact credit and bill open-item IDs,
  amount, period/date, AP control and realized gain/loss mappings.
- `finlynq_daily_void_supplier_credit_application`: exact current version and
  reversal date/period/reason. `finlynq_daily_get_document` reads both new kinds.

Deploy migration `0101_supplier_credit_notes` and its matching generated journal
registry seed together with the application. No existing accounting history is
rewritten. API routes are `/api/payables/credits` (POST/PATCH), its `/issue` and
`/void` actions, and `/api/payables/credit-applications` with `/void`.
