# FX rate providers

FinLynQ resolves accounting FX from organization-owned evidence. Automatic
foreign-currency resolution always checks eligible stored organization rates
before considering an external provider. Every organization starts with the
`STORED_ONLY` policy and a seven-day provider-lookback default that remains
inactive in that mode. Yahoo Finance is an experimental, two-gate option: an
organization administrator must explicitly select and acknowledge
`YAHOO_FINANCE_EXPERIMENTAL`, and the operator must separately set
`YAHOO_FX_ENABLED=true` for that deployment.

Keep the Yahoo gate off in production. Enabling a technical gate does not grant
FinLynQ any market-data rights and does not replace the organization's
acknowledgement.

## Resolution contract

Caller-supplied explicit FX evidence and the functional-currency identity rate
remain their existing, separate paths. When a foreign-currency accounting
request omits `fx`, FinLynQ resolves it in this order:

1. Select the latest eligible, enabled, organization-owned rate for the exact
   transaction-currency to functional-currency pair whose UTC effective date is
   on or before the accounting date. Settlement requests use the settlement
   date. Effective time, recorded time, and rate ID break ties deterministically.
2. If no stored rate is eligible, continue only when the organization's active
   policy is `YAHOO_FINANCE_EXPERIMENTAL`, its current acknowledgement is
   present, and `YAHOO_FX_ENABLED=true` at the operator boundary.
3. Ask Yahoo for the exact direct pair and select the latest positive daily
   close on the requested UTC date or within the organization's configured
   one-to-seven-calendar-day lookback. Seven days is the hard maximum.
4. If no acceptable observation exists, fail with `FX_RATE_UNAVAILABLE` before
   creating a draft, linking evidence, allocating a settlement, or moving a
   cloud document.

FinLynQ does not invert a quote, triangulate through USD or another currency,
substitute a hardcoded rate, or reuse an unbounded stale provider observation.
An old administrator-approved organization rate remains governed by the
organization's existing effective-date policy; it is stored accounting evidence,
not an automatic provider fallback.

Rates use the accounting convention **functional-currency units for one
transaction-currency unit**. For example, a USD invoice in a CAD-functional
ledger requires a direct USD to CAD observation. Yahoo's direct ticker for that
pair is `CAD=X`; CAD to USD is `CADUSD=X`, and EUR to CAD is `EURCAD=X`. The
adapter validates the returned symbol, target currency, `CURRENCY` instrument
type, and daily granularity. A response for the reverse pair is rejected rather
than inverted.

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
as retryable retrieval failures, but the adapter makes one request and never
relaxes the accounting rules or triggers another rate source. A later authorized
operation may retry explicitly.

## Immutable evidence

A successful Yahoo observation is not appended to the administrator-maintained
`currency_exchange_rates` history. FinLynQ freezes it directly in the immutable
document or settlement snapshot so an external observation cannot be mistaken
for a manually approved organization rate.

The accounting rate is handled as an exact decimal and rounded to no more than
18 decimal places for the snapshot. Provider provenance uses mode
`PROVIDER_RATE`, source `Yahoo Finance / ICE Data Services`, provider key
`YAHOO_FINANCE_EXPERIMENTAL`, and policy key
`YAHOO_FINANCE_EXPERIMENTAL_DIRECT_DAILY_CLOSE`. It also records the source and
target currencies, quote convention and direct quote direction, requested as-of
date, Yahoo symbol, close observation time, retrieval/resolution time,
raw-response SHA-256, the organization policy version, and the policy's maximum
lookback. The raw Yahoo response is not a general-purpose market-data cache.
Administrator-recorded rates keep their existing immutable rate identity,
source, effective time, recorded time, and resolver provenance.

Replaying an idempotency key returns the original immutable accounting snapshot.
Later rate records, policy changes, provider failures, or disabling either Yahoo
gate do not rewrite historical drafts, journals, open items, settlements, or
attachment evidence.

## Organization authorization

Only an organization administrator with organization-settings permission may
change the policy. A real-account administrator must also complete a recent MFA
step-up; demo mutation remains subject to the separate demo-write gate. In
**Settings → Accounting configuration → Currencies & effective-dated rates**,
the administrator selects a one-to-seven-day maximum lookback and records a
reason. The equivalent MCP
operation is `finlynq_setup_configure_fx_provider_policy`; it applies the same
organization permission, MFA, expected-version, acknowledgement, and audit
checks. Neither control fetches market data while saving the policy.

`STORED_ONLY` requires no external-provider acknowledgement. Before selecting
`YAHOO_FINANCE_EXPERIMENTAL`, the administrator must explicitly acknowledge
that:

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

Record the administrator, acknowledgement version, timestamp, and policy change
in the organization audit trail. Selecting `STORED_ONLY` withdraws the opt-in for
future automatic lookups. It does not delete stored rates or alter historical
snapshots.

The operator gate is independent. Turning `YAHOO_FX_ENABLED` off prevents new
Yahoo requests for every organization in that deployment. Organization policies
and acknowledgements remain visible so an operator outage or legal hold does not
silently rewrite tenant configuration; stored and explicit FX paths continue to
work.

## Provider and licensing review

As checked on 2026-09-05, Yahoo's [public API catalogue](https://developer.yahoo.com/api/)
lists supported products such as Fantasy Sports and Sign In with Yahoo, but does
not document the Finance chart route used by this experiment. The public
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

From a clean, reviewed `dev` checkout, enable the development gate explicitly:

```bash
sudo bash deploy/development/install-development.sh \
  --enable-yahoo-fx-experimental \
  --enable
sudo systemctl start business-finlynq-development-deployment.service
```

The installer writes `YAHOO_FX_ENABLED=true` to the development Compose
environment. The deployer treats a gate change as configuration drift and
recreates the app even when the Git revision is unchanged. This command does not
change any organization's `STORED_ONLY` policy; an administrator must opt in
separately in FinLynQ.

Disable external retrieval without changing stored evidence:

```bash
sudo bash deploy/development/install-development.sh \
  --disable-yahoo-fx \
  --enable
sudo systemctl start business-finlynq-development-deployment.service
```

Confirm the deployment service succeeds and the detailed health response reports
the expected revision. Do not print
`/etc/business-finlynq-development/compose.env` or copy it into an incident
report. If activation fails, leave the gate off and use stored organization
rates while investigating.

There is deliberately no production activation procedure in this runbook.
Production Compose defaults the gate to false, and restore/rehearsal paths force
it off.

## Verification

The ordinary CI suite uses injected provider responses. It must not call Yahoo.
Mocked tests cover the disabled gate, exact symbols and direction, seven-day UTC
window, latest positive close, future-date rejection, metadata mismatch, no
fallback, redirects, content type and response-size bounds, timeout behavior,
and HTTP 429 classification. Resolver and database tests must separately cover
stored-first precedence, both authorization gates, organization isolation,
immutable evidence, idempotent replay, and fail-before-write behavior.

Mocked CI proves deterministic application behavior. It does not prove live
endpoint availability, quote correctness, legal authorization, attribution
compliance, or provider rate limits.

An optional live check is permitted only in an authorized non-production
deployment after the operator review and an organization administrator's opt-in.
Use one enabled direct pair and a known accounting date, verify the ticker
direction and returned observation time, create the draft, and inspect the
immutable evidence. Then disable the operator gate and confirm stored-rate
resolution still works while a new provider-only pair fails before any write.
Do not make live checks a CI or deployment acceptance dependency.

Direct probes on 2026-09-05 were mixed: one request returned a positive
`CADUSD=X` chart response, while separate requests to the `query1` and `query2`
Finance hosts received HTTP 429. That result demonstrates intermittent access,
not a service-level commitment, supported API status, or permission to use the
data.
