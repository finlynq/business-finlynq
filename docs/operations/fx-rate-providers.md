# FX rate providers

FinLynQ resolves accounting FX from organization-owned evidence. An authorized
invoice or settlement request may supply its own explicit rate. When the request
omits `fx`, automatic resolution checks eligible stored organization rates
before considering the organization's selected external source. Every
organization starts with the `STORED_ONLY` policy and a seven-day provider
lookback default that remains inactive in that mode.

| Organization mode | Automatic behavior after a stored-rate miss | Additional gate |
| --- | --- | --- |
| `STORED_ONLY` | Stop with `FX_RATE_UNAVAILABLE` | None |
| `BANK_OF_CANADA` | Resolve from official daily CAD-based Valet observations, using an inverse or a common-date CAD cross when needed | Organization administrator policy selection |
| `EUROPEAN_CENTRAL_BANK` | Resolve from official daily EUR reference-rate observations, using an inverse or a common-date EUR cross when needed | Organization administrator policy selection |
| `YAHOO_FINANCE_EXPERIMENTAL` | Request only the exact direct Yahoo daily pair | Organization acknowledgement and deployment-wide operator gate |

Bank of Canada and ECB modes do not require customer OAuth credentials, an API
key, or a deployment feature flag. They use public official endpoints. Yahoo
Finance remains an experimental, two-gate option: an organization administrator
must explicitly select and acknowledge `YAHOO_FINANCE_EXPERIMENTAL`, and the
operator must separately set `YAHOO_FX_ENABLED=true` for that deployment.

Keep the Yahoo gate off in production. Enabling a technical gate does not grant
FinLynQ any market-data rights and does not replace the organization's
acknowledgement.

## Resolution contract

Rates use the accounting convention **target/functional-currency units for one
source/transaction-currency unit**. FinLynQ resolves them in this order:

1. Use the canonical identity rate for functional-currency documents. A supplied
   unit rate remains identity evidence; a non-unit same-currency override is
   rejected.
2. For a cross-currency request that supplies `fx`, validate and freeze its
   positive rate, source, effective time, and direct quote convention. This
   client-supplied evidence is used only for that invoice or settlement. It does
   not create an organization rate, change provider policy, or call an external
   source.
3. Select the latest eligible, enabled, organization-owned rate for the exact
   transaction-currency to functional-currency pair whose UTC effective date is
   on or before the accounting date. Settlement requests use the settlement
   date. Effective time, recorded time, and rate ID break ties deterministically.
4. If no stored rate is eligible, use only the external mode selected by the
   organization. Bank of Canada and ECB may derive the requested direction from
   their fixed-base observations as described below. Yahoo requires its two
   gates and an exact direct pair. No mode falls through to another provider.
5. Select the latest positive observation on the requested UTC date or within
   the organization's configured one-to-seven-calendar-day lookback. For a
   cross, both published legs must exist on the same date. Seven calendar days is
   the hard maximum.
6. If no acceptable observation exists, fail with `FX_RATE_UNAVAILABLE` before
   creating a draft, linking evidence, allocating a settlement, or moving a
   cloud document.

An old administrator-approved organization rate remains governed by the
organization's existing effective-date policy; it is stored accounting evidence,
not an automatic provider fallback. External modes never substitute a hardcoded
rate, mix cross legs from different dates, use a future observation, reuse an
unbounded stale observation, or retry through a different source.

### Bank of Canada calculations

The [Bank of Canada Valet API](https://www.bankofcanada.ca/valet/docs/)
publishes each supported daily FX series as Canadian dollars per unit of the
foreign currency. Let `C(S)` be CAD per source-currency unit and `C(T)` be CAD
per target-currency unit on one common observation date:

| Requested conversion | Calculation | Evidence |
| --- | --- | --- |
| source → CAD | `C(S)` | One unmodified `FX{source}CAD` observation |
| CAD → target | `1 / C(T)` | One unmodified `FX{target}CAD` observation plus the disclosed inverse |
| source → target | `C(S) / C(T)` | Two unmodified Valet observations from the same date plus the disclosed CAD cross |

For example, a USD invoice in a CAD-functional ledger uses `FXUSDCAD`
directly. A USD invoice in an EUR-functional ledger divides `FXUSDCAD` by
`FXEURCAD` from the same date. Unsupported or suspended series fail closed.
FinLynQ makes one bounded Valet request containing the one or two required
series.

### ECB calculations

The [ECB Data Portal API](https://data.ecb.europa.eu/help/api/overview)
publishes its daily reference series as currency units per euro. Let `E(S)` be
source-currency units per EUR and `E(T)` be target-currency units per EUR on one
common observation date:

| Requested conversion | Calculation | Evidence |
| --- | --- | --- |
| EUR → target | `E(T)` | One unmodified `EXR.D.{target}.EUR.SP00.A` observation |
| source → EUR | `1 / E(S)` | One unmodified `EXR.D.{source}.EUR.SP00.A` observation plus the disclosed inverse |
| source → target | `E(T) / E(S)` | Two unmodified ECB observations from the same date plus the disclosed EUR cross |

For example, a USD invoice in an EUR-functional ledger uses the inverse of the
published USD-per-EUR observation. A USD invoice in a CAD-functional ledger
divides CAD-per-EUR by USD-per-EUR from the same date. FinLynQ requests only the
one or two required daily series. A currency the ECB does not publish, including
a suspended series, fails closed.

Central banks normally publish only on working days. For weekends, public
holidays, and publication delays, FinLynQ selects the newest common observation
no later than the requested UTC date and no older than the organization's
one-to-seven-calendar-day lookback. A cross is unavailable when only one leg is
present for an eligible date.

### Yahoo direct observations

For example, a USD invoice in a CAD-functional ledger requires a direct USD to
CAD observation. Yahoo's direct ticker for that pair is `CAD=X`; CAD to USD is
`CADUSD=X`, and EUR to CAD is `EURCAD=X`. The adapter validates the returned
symbol, target currency, `CURRENCY` instrument type, and daily granularity. A
response for the reverse pair is rejected rather than inverted.

The Yahoo request is server-side and fixed to:

```text
GET https://query1.finance.yahoo.com/v8/finance/chart/{encoded-symbol}
```

It requests a bounded daily-history envelope from seven days before the
requested UTC date through the start of the next UTC day. The resolver then
applies the organization's configured lookback, which may be from one through
seven calendar days. Future dates and observations after the requested date are
rejected. The adapter follows no redirects, permits only the fixed origin,
uses a four-second timeout, disables the HTTP cache, accepts JSON only,
and reads at most 128 KiB. HTTP 429 and server/network failures are classified
as retryable retrieval failures. The adapter never relaxes the accounting rules
or triggers another rate source. A later authorized operation may retry
explicitly.

The Bank of Canada and ECB adapters share a bounded, process-local cache of
parsed observations. Concurrent requests for the same provider, currency pair,
and requested date share one retrieval; a successful observation remains
eligible for five minutes, with at most 128 keys per application process.
Failures are evicted immediately. The cache has no timers, is not shared between
application instances, and stores neither credentials nor a separate raw
response body. Provider HTTP requests still use `no-store`. Each completed
accounting operation copies the selected observation, source legs, retrieval
time, and response hash into its own immutable snapshot.

## Immutable evidence

A successful external observation is not appended to the
administrator-maintained `currency_exchange_rates` history. FinLynQ freezes it
directly in the immutable document or settlement snapshot so provider evidence
cannot be mistaken for a manually approved organization rate.

The accounting rate is handled as an exact decimal and rounded to no more than
18 decimal places for the snapshot. Every external result records mode
`PROVIDER_RATE`, the attributed source, provider key, source and target
currencies, quote convention, requested as-of date, selected observation time,
retrieval and resolution times, raw-response SHA-256, organization policy
version, and maximum lookback. The raw response is not retained as a general-purpose market-data cache. The
short process-local observation cache described above only reduces repeated
public-provider requests; it is not an accounting record or a source for later
historical reconstruction.

Bank of Canada and ECB evidence also records the calculation type and formula.
Each source leg retains its official series key, unmodified published decimal,
currency, and observation date. An inverse has one source leg; a cross has two
legs from one common date. This distinguishes the central bank's published
observations from FinLynQ's derived accounting rate and makes the result
recalculable.

Yahoo provenance keeps provider key `YAHOO_FINANCE_EXPERIMENTAL`, source
`Yahoo Finance / ICE Data Services`, policy key
`YAHOO_FINANCE_EXPERIMENTAL_DIRECT_DAILY_CLOSE`, and its exact direct symbol.
Existing Yahoo snapshots remain valid.

Client-supplied FX uses separate explicit provenance. The snapshot records the
rate, caller-provided source, effective time, source and target currencies, and
direct quote convention. It never claims Bank of Canada, ECB, or Yahoo
provenance unless that evidence was actually resolved through the corresponding
automatic adapter. Administrator-recorded rates keep their existing immutable
rate identity, source, effective time, recorded time, and resolver provenance.

Replaying an idempotency key returns the original immutable accounting snapshot.
Later rate records, policy changes, provider failures, or disabling the Yahoo
gate do not rewrite historical drafts, journals, open items, settlements, or
attachment evidence. Snapshots created before these provider modes remain
readable under their historical schema.

## Organization authorization

Only an organization administrator with organization-settings permission may
change the automatic policy. A real-account administrator must also complete a
recent MFA step-up; demo mutation remains subject to the separate demo-write
gate. In **Settings → Accounting configuration → Currencies & effective-dated
rates**, the administrator selects a mode, chooses a one-to-seven-day maximum
lookback, and records a reason. The equivalent MCP operation is
`finlynq_setup_configure_fx_provider_policy`; it applies the same organization
permission, MFA, expected-version, acknowledgement, and audit checks. Neither
control fetches market data while saving the policy.

`STORED_ONLY`, `BANK_OF_CANADA`, and `EUROPEAN_CENTRAL_BANK` do not use the
Yahoo licensing acknowledgement. Selecting a central bank mode means the
administrator accepts that official reference observations may be delayed,
unavailable, revised, and unsuitable for the organization's accounting, tax, or
regulatory policy. Stored rates continue to win before that source. A policy
change does not delete stored rates or alter historical snapshots.

Before selecting `YAHOO_FINANCE_EXPERIMENTAL`, the administrator must
explicitly acknowledge that:

- the organization is licensed and authorized to use Yahoo Finance data for this
  accounting workflow;
- Yahoo Finance is experimental and may be delayed, incomplete, rate-limited,
  changed, or unavailable;
- the chart route is not listed as a supported Yahoo Finance API in Yahoo's
  public developer API catalogue;
- the organization remains responsible for reviewing the rate and determining
  whether its use, retention, display, and attribution are permitted for its
  accounting purpose; and
- an unavailable or invalid quote stops the write with `FX_RATE_UNAVAILABLE`
  rather than producing an estimated conversion.

Record the administrator, acknowledgement version where applicable, timestamp,
and policy change in the organization audit trail. Selecting `STORED_ONLY`
withdraws the Yahoo opt-in for future automatic lookups. It does not delete
stored rates or alter historical snapshots.

The Yahoo operator gate is independent. Turning `YAHOO_FX_ENABLED` off
prevents new Yahoo requests for every organization in that deployment. It does
not disable Bank of Canada or ECB. Organization policies and acknowledgements
remain visible so an operator outage or legal hold does not silently rewrite
tenant configuration; stored and explicit FX paths continue to work.

An authorized invoice or settlement writer can use explicit FX for a
rate-sensitive transaction without changing the organization's automatic
policy. Browser and MCP operations apply the ordinary organization and
accounting permissions, and the override is confined to that request and its
idempotent replay. Use a source label and effective time that let an accountant
identify the contract, bank advice, tax authority rate, or other approved
evidence. Do not enter a rate with the inverse quote convention.

## Provider and reuse review

The following official terms were checked on 2026-09-05. Recheck them when the
provider changes its terms, the attribution UI changes, or FinLynQ's
distribution and pricing model changes.

### Bank of Canada

The [Valet how-to guide](https://www.bankofcanada.ca/valet-api-how-to/) says the
API requires no registration or access key and has no cost. The
[Bank of Canada terms](https://www.bankofcanada.ca/terms/) generally permit free
use, copying, distribution, and transmission of Bank website content, subject
to attribution, disclosure of changes, and due diligence on accuracy. They also
require a paid service or document for sale to tell prospective purchasers that
the information came from, and is available free from, the Bank's website.
Request-rate limits must not be circumvented, and the Bank's logo or wordmark
must not be reproduced without permission.

FinLynQ attributes every source leg to the Bank of Canada and labels each inverse
or CAD cross as a FinLynQ calculation. It does not use the Bank's logo. If
FinLynQ later charges for access to these rates, add the required free-source
notice before the user pays and whenever the terms require it. The terms
separately exclude third-party content unless reuse is expressly permitted; the
Bank's exchange-rate disclosure says its underlying data is sourced from LSEG.
Retain the terms review and obtain legal confirmation before turning the rate
feed itself into a redistributed data product.

The Bank describes its exchange rates as indicative, derived from averages of
transaction prices and quotes, released for statistical and analytical purposes,
and not a benchmark for executing FX trades. The Bank does not guarantee
accuracy, completeness, or availability. An organization that needs a
contractual, tax-authority, settlement, or executable rate should store its
approved rate or supply explicit FX evidence for the transaction.

### European Central Bank

The [ESCB statistics reuse policy](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html)
permits free commercial and non-commercial reuse of publicly released
statistics when the source is quoted and the published statistics and metadata
remain unmodified. It excludes third-party data without the originator's
permission and gives no guarantee that a series will continue. The
[ECB disclaimer](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html)
requires accurate reproduction and citation; when a user modifies information,
the modification must be stated explicitly.

FinLynQ preserves and attributes each source leg as “Source: ECB statistics.”
It records the published decimal and metadata without changing them, and
separately labels an inverse or EUR cross as a FinLynQ calculation with its
formula. A derived accounting rate must not be displayed as if the ECB published
that direct pair.

The [ECB reference-rate page](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)
says rates are normally published each working day, are for information
purposes, and are strongly discouraged for transaction use. They carry no
service-level commitment. An organization administrator must decide whether
these reference rates meet its accounting and regulatory requirements; clients
with stricter requirements should use stored or explicit evidence.

### Yahoo Finance experimental mode

Yahoo's [public API catalogue](https://developer.yahoo.com/api/) lists supported
products such as Fantasy Sports and Sign In with Yahoo, but does not document
the Finance chart route used by this experiment. The public
[Yahoo Terms of Service](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html)
restrict automated collection without prior permission. Yahoo Finance's
[exchange and data-provider notice](https://help.yahoo.com/kb/SLN2310.html)
says its information is informational and must not be redistributed, and
identifies third-party market-data providers. A consumer
[Yahoo Finance subscription](https://finance.yahoo.com/about/plans/) does not by
itself document application API, retention, or redistribution rights.

Yahoo's [Developer API Terms](https://legal.yahoo.com/us/en/yahoo/terms/product-atos/apiforydn/index.html)
also impose API-specific use, storage, rate-limit, and attribution conditions,
and the [attribution guidelines](https://developer.yahoo.com/attribution/)
describe “Powered by Yahoo” display and linking requirements for supported Yahoo
APIs. These general documents do not turn the undocumented chart route into a
licensed public Finance API.

Before enabling the operator gate, retain a review showing that the deployment's
Yahoo and relevant market-data-provider agreement permits automated retrieval,
commercial application use, the immutable accounting evidence retained by
FinLynQ, customer display, and the intended attribution. Recheck the linked
terms and product catalogue before each production decision because Yahoo may
change them. Production remains `YAHOO_FX_ENABLED=false` until that review and
customer-facing attribution work are complete.

## Development activation and rollback

Bank of Canada and ECB require no provider credentials or deployment feature
flag. Once the application revision and its FX-policy migration are deployed,
an organization administrator can select `BANK_OF_CANADA` or
`EUROPEAN_CENTRAL_BANK` in development. The application container needs
outbound HTTPS access to the fixed official origin. Selecting `STORED_ONLY`
stops future automatic central-bank calls without a deployment restart and
preserves stored rates and historical snapshots. If the official source is
unavailable, use stored organization evidence or an explicit transaction rate;
do not configure automatic fallback to a different provider.

Yahoo remains separately gated. From a clean, reviewed `dev` checkout, enable
the development gate explicitly:

```bash
sudo bash deploy/development/install-development.sh \
  --enable-yahoo-fx-experimental \
  --enable
sudo systemctl start business-finlynq-development-deployment.service
```

The installer writes `YAHOO_FX_ENABLED=true` to the development Compose
environment. The deployer treats a gate change as configuration drift and
recreates the app even when the Git revision is unchanged. This command does not
change any organization's policy; an administrator must opt in separately in
FinLynQ.

Disable Yahoo retrieval without changing stored evidence or the central-bank
modes:

```bash
sudo bash deploy/development/install-development.sh \
  --disable-yahoo-fx \
  --enable
sudo systemctl start business-finlynq-development-deployment.service
```

Confirm the deployment service succeeds and the detailed health response reports
the expected revision. Do not print
`/etc/business-finlynq-development/compose.env` or copy it into an incident
report. If Yahoo activation fails, leave its gate off while investigating.

Do not change production as part of development validation. A central-bank mode
becomes available in another environment only when this application revision
and migration are deliberately promoted there. There is deliberately no Yahoo
production activation procedure in this runbook; production Compose defaults
the Yahoo gate to false, and restore/rehearsal paths force it off.

## Verification

Ordinary CI uses injected transport responses and must not call Bank of Canada,
ECB, or Yahoo. Mocked adapter tests cover:

- Bank of Canada exact series and CAD orientation, direct, inverse, common-date
  CAD cross, supported-currency rejection, seven-day UTC window, wrong metadata,
  missing observations, redirects, content type and response-size bounds,
  timeout, and HTTP failure classification;
- ECB exact daily `EXR` series metadata and EUR orientation, direct, inverse,
  common-date EUR cross, mismatched leg dates, seven-day UTC window, malformed
  CSV, missing or suspended observations, redirects, content type and
  response-size bounds, timeout, and HTTP failure classification; and
- Yahoo's disabled gate, exact direct symbols and direction, seven-day UTC
  window, latest positive close, future-date rejection, metadata mismatch, no
  fallback, redirects, content type and response-size bounds, timeout behavior,
  and HTTP 429 classification.

Resolver and database tests separately cover stored-first precedence for every
automatic mode, explicit-client-rate precedence, provider-policy permissions and
organization isolation, common-date calculation evidence, exact decimal
rounding, immutable snapshots, historical snapshot compatibility, idempotent
replay, and failure before any accounting or cloud-file write.

These are mocked tests. They prove deterministic application behavior and
failure boundaries, but they do not prove live endpoint reachability, current
series availability, published-value correctness, provider rate limits, or
continued compliance with source terms.

For live central-bank validation, use an authorized non-production organization
with no eligible stored rate for the test pair. Test each mode separately
against a recent published working day:

1. Resolve a direct base-currency pair, an inverse pair, and a cross.
2. Compare every saved source leg, series key, decimal, and observation date with
   the official API response. For a cross, verify both legs have one date and
   recalculate the saved result from the recorded formula.
3. Repeat with a weekend or holiday accounting date and confirm the chosen
   observation is no later than the request and within the configured calendar
   lookback.
4. Supply an explicit client rate with a recognizable source and effective time;
   confirm that exact rate is frozen and no central-bank provenance is claimed.
5. Use an unsupported pair or a lookback with no common date and confirm
   `FX_RATE_UNAVAILABLE` occurs before draft creation, evidence linking,
   settlement allocation, or cloud filing.

Record the live account type, mode, pair, as-of date, observation date, outcome,
and deployed revision. Do not record credentials, tokens, or complete provider
responses. A live check is operational evidence for that date and revision, not
a service-level commitment. Keep live provider calls out of CI.

A Yahoo live check is permitted only in an authorized non-production deployment
after the operator review, the deployment gate, and an organization
administrator's opt-in. Use one enabled direct pair and a known accounting date,
verify its exact ticker and returned observation time, create the draft, and
inspect the immutable evidence. Then disable the Yahoo operator gate and confirm
stored-rate resolution still works while a Yahoo-only pair fails before any
write.

Direct Yahoo probes on 2026-09-05 were mixed: one request returned a positive
`CADUSD=X` chart response, while separate requests to the `query1` and
`query2` Finance hosts received HTTP 429. That result demonstrates intermittent
access, not a service-level commitment, supported API status, or permission to
use the data.
