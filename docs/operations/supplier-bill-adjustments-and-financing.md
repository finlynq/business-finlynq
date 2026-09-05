# Supplier-bill adjustments, account validity, and financing

## Signed supplier-bill adjustments

A supplier bill may contain negative distribution lines when the final supplier
payable remains positive. Set each negative line's `lineType` to
`ADJUSTMENT`. Keep the adjustment as its own line with its source description,
expense or asset account combination, tax category, evidence reference, and
recoverability facts.

FinLynQ calculates tax for each signed taxable basis. A negative taxable
adjustment therefore produces negative tax components with the same line-level
rounding rule as a positive charge. At posting, the negative distribution and
recoverable tax reverse from debit to credit. The AP control entry remains the
positive gross amount owed to the supplier.

A negative line without `lineType: "ADJUSTMENT"` fails with
`SIGNED_LINE_REQUIRES_ADJUSTMENT` and identifies the line. Negative
sales-invoice lines remain unsupported. A zero-gross document fails with
`ZERO_GROSS_UNSUPPORTED` because FinLynQ does not create a zero-value open
item. A net supplier credit fails with `SUPPLIER_CREDIT_NOTE_REQUIRED`; it is
never converted into a positive bill or silently netted against another
document. A dedicated supplier credit-note workflow is not implemented yet.

Existing source snapshots that predate `lineType` remain readable. Omitting
`lineType` from a positive line also preserves legacy command
fingerprints. New browser-created lines send an explicit `STANDARD` or
`ADJUSTMENT` value.

## Account-combination diagnostics

AR/AP draft and settlement validation evaluates every supplied combination
against the organization, ledger, legal entity, accounting date, account
status, posting status, control kind, account class, and party control account.
All failing request fields are returned together under
`accountCombinationFailures`.

A tenant-authorized failure includes:

- the request field and source line number, when applicable;
- the supplied combination ID and safe account code/name;
- combination and natural-account active flags and posting status;
- natural-account `validFrom` and `validTo`;
- ledger and entity mismatch flags;
- the evaluated accounting date; and
- one or more stable reason codes, including `FUTURE_DATED`, `EXPIRED`,
  `WRONG_LEDGER`, `WRONG_ENTITY`, `WRONG_CONTROL_KIND`,
  `WRONG_ACCOUNT_CLASS`, and `PARTY_CONTROL_ACCOUNT_MISMATCH`.

An identifier that is absent from the connected organization returns only
`NOT_FOUND_OR_UNAUTHORIZED`. Its code, name, status, dates, ledger, and entity
remain undisclosed.

Call `finlynq_setup_get_configuration` or
`finlynq_daily_get_accounting_context` with the intended ISO accounting date
before a write. The setup response includes each organization-owned
combination's control kind, active/postable facts, effective dates, and
`validOnAccountingDate`. The daily context includes effective dates and the
same requested-date result for postable non-control combinations. Fix or add
configuration when no permitted combination is valid. Do not move a document's
accounting date merely to bypass an effective-date rule.

## Financed purchases: currently supported composition

The existing payables model can preserve a full purchase basis and reclassify a
financed portion in two source-owned steps:

1. Create and issue the supplier bill for the full asset or expense basis and
   line-level tax shown by the source invoice.
2. Record an idempotent supplier settlement for the financed portion using
   `settlementMethod: "OTHER_NON_CASH"` (or another truthful supported
   method) and an active, postable, non-control liability combination.
   This debits AP and credits that liability.
3. Leave the genuinely current amount in AP and settle it separately through
   the bank when paid.
4. Attach the invoice and supporting schedule to the bill. The settlement is
   linked to the bill's open item and immutable accounting evidence.

This composition does not provide a financing schedule, one combined
bill-and-financing preview, automated principal/interest allocation, or a
subledger operation that settles the secondary liability. Later instalments,
interest, early payoff, returns, and device credits therefore require reviewed
general-ledger treatment outside the payables open-item workflow.

Completing a first-class financed-purchase feature requires a product decision
between:

- a financing subledger with immutable agreement terms, schedules, positions,
  principal/interest movements, returns, payoff, reversal, and evidence
  lineage; or
- an atomic composite command that issues a bill and immediately creates one or
  more non-cash AP settlements, while future liability movements remain general
  ledger entries.

The first model supports the full requested lifecycle. The composite model is
smaller, but it does not provide financing balances or installment controls.
Do not add an arbitrary second liability line to a supplier bill without one of
these governed models; that would bypass AP control and could duplicate the
asset or input tax.
