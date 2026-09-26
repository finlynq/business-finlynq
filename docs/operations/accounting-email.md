# Accounting email operations

Accounting email is a tenant-scoped automation surface for inbound document
capture and outbound invoice delivery. Authentication email remains a separate
worker and credential boundary.

## Environment boundary and provider setup

Incoming mail uses the same **self-hosted Mailpit → DevManager → signed HTTPS
push** protocol as Personal Finlynq. Resend is **outbound only**, including
authentication mail and invoice delivery events. The former
`/api/email/inbound/resend` endpoint returns 410 and does not ingest anything.
Do not create a Resend receiving subscription or configure inbound Resend MX.

| Purpose | Development value |
| --- | --- |
| Application | `https://dev.business.finlynq.com` |
| Existing shared inbound domain | `mail.finlynq.com` |
| Inbound alias prefix | `businessdev-` |
| Inbound relay endpoint | `https://dev.business.finlynq.com/api/email/inbound/self-smtp` |
| Outbound domain | `mail.dev.business.finlynq.com` |
| Resend delivery-event webhook | `https://dev.business.finlynq.com/api/email/events/resend` |

Install single-line files outside Git as `root:business-finlynq-secrets`, mode
`0440`. Receiving needs only a **new, independently generated >=32-character
random relay secret**, shared with the corresponding Business relay route.
Never reuse Personal's secret, a Resend `whsec_`, or another environment's
secret. The old `ACCOUNTING_EMAIL_INBOUND_WEBHOOK_SECRET_FILE` is no longer read.

```dotenv
ACCOUNTING_EMAIL_INBOUND_RELAY_SECRET_FILE=/etc/business-finlynq-dev/secrets/accounting-email-inbound-relay-secret
BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN=mail.finlynq.com
BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX=businessdev-
# Optional outbound invoice delivery only:
ACCOUNTING_EMAIL_RESEND_API_KEY_FILE=/etc/business-finlynq-dev/secrets/accounting-resend-api-key
ACCOUNTING_EMAIL_OUTBOUND_WEBHOOK_SECRET_FILE=/etc/business-finlynq-dev/secrets/accounting-email-outbound-webhook-secret
BUSINESS_FINLYNQ_OUTBOUND_EMAIL_DOMAIN=mail.dev.business.finlynq.com
```

Set these in the root-managed environment's `compose.env`. The app receives
fixed `/run/secrets/...` paths. Missing/invalid relay secret, domain or prefix
keeps receiving disabled (503). A known deployed `APP_ORIGIN` must match its
prefix; missing or broken Resend credentials do not disable
receiving. The settings page reports **receiver configuration**, not proof that
DNS, the external relay or SMTP delivery has been validated.

Dev/stage deployment acceptance also compares the inbound domain/prefix, secret
mount source/read-only mode and mounted bytes with the reviewed Compose config.
Installing a secret is not enough: an existing container can retain an inert
mount (or an old inode after rotation). Use the protected deployment service to
reconcile it; do not manually recreate the app or skip public acceptance.
If acceptance redirects to `demoError=unavailable`, check the demo reset deadline
separately: an overdue shared demo rejects new sessions. The normal candidate
deployment runs its existing ordered demo-bootstrap step before acceptance.

### Relay activation (separate operator change)

DevManager supports independent Business routes, initially disabled.
**Do not repoint `FINLYNQ_INBOUND_WEBHOOK_URL`,
`FINLYNQ_DEV_WEBHOOK_URL`, `MAIL_IMPORT_DOMAIN`, or their secrets to Business.**
Reuse the existing `mail.finlynq.com` receiver and its existing DNS. No DNS
change is needed. DevManager selects the destination by these local prefixes:

| Application/environment | Local part on `mail.finlynq.com` |
| --- | --- |
| Personal production (unchanged) | `import-<existing token>` |
| Personal development (unchanged) | `importdev-<existing token>` |
| Business production | `business-<32 hex characters>` |
| Business stage | `businessstage-<32 hex characters>` |
| Business development | `businessdev-<32 hex characters>` |

Before activating each Business route:

- Set `BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX` to its exact prefix above on the
  app and `BUSINESS_FINLYNQ_ENV_MAIL_DOMAIN=mail.finlynq.com` on DevManager.
  DevManager fixes the Business prefix by environment. The app also rejects a
  signed recipient with the wrong prefix, domain or token length before ingestion.
- Forward to that environment's `/api/email/inbound/self-smtp` using its own
  HMAC secret. Leave all existing DNS, Personal secrets and outbound records unchanged.
- Confirm retry-on-failure behavior. DevManager has an optional
  `MAIL_DROP_ON_FAILURE` privacy mode which **deletes mail even on failed
  forwarding**. Business needs `dropOnFailure=false` on its own route/instance,
  deletion only after a durable 2xx acknowledgment, and reconciliation enabled.
  Do not change Personal's retention policy globally to achieve this.
- Check relay limits against the receiver: 20 MiB JSON, 10 MiB decoded bodies
  plus attachments, at most 20 attachments. Only safe PDFs up to 2 MiB enter
  document processing; other supported-size files are encrypted in quarantine.
  Next's proxy buffer is set to 20 MiB + 1 byte so it cannot silently truncate
  valid signed bodies at the framework's default 10 MiB. The route rejects
  overflow; any additional ingress proxy must permit the full 20 MiB payload.
- Run an actual synthetic SMTP delivery plus a replay/failure test before
  advertising addresses as usable. An app deployment alone is not activation.

No Mailpit API credentials belong in Business. Business never polls, downloads
from, or deletes messages in Mailpit.

### Signed push contract

Headers: `Content-Type: application/json`, `X-Mail-Timestamp` (ISO UTC),
`X-Mail-Signature: sha256=<64 lowercase hex>`, and optionally
`X-Mail-Message-Id` matching the payload. HMAC-SHA256 uses the raw shared secret
over `timestamp + "." + exact raw request body`; timestamps must be within
five minutes, including future skew. Send a fresh signature when retrying.

Payload is Personal's `NormalizedInboundEmail`:
`message_id`, nullable `smtp_message_id`, `from: {name,address}`,
`to: [{name,address}]`, `recipient`, `subject`, nullable `text`/`html`,
`received_at`, and `attachments: [{filename,content_type,size,content_base64}]`.
Names may be null. Attachments use canonical base64 and exact nonzero sizes.
There are no attachment URLs. The app routes **only `recipient`**, including
Bcc/envelope-only delivery; other To recipients cannot fan out across tenants.
Sender SPF/DKIM/DMARC remain UNKNOWN because the signed relay authenticates
transport, not the SMTP sender.

Use the stable **Mailpit `message_id`**, not sender-controlled SMTP Message-ID,
for deduplication. Retries cannot create a second message per alias.
2xx means encrypted content is durably staged/quarantined or the recipient was
deliberately ignored (unknown, rotated, or disabled membership/alias).
Storage-not-configured mail is durably retry-pending and also receives 2xx.
Invalid signatures return 401; malformed/mismatched payloads 400, oversized
bodies 413, wrong content type 415, and unavailable configuration/database 503.
Non-2xx must not be treated as successful delivery by the relay.

Migration 0077 accepts SELF_SMTP while retaining historical RESEND provenance.
It changes only the default for new aliases and widens reviewed checks; it does
not rewrite old message history, ownership, addresses, RLS, grants, or audit
records. New/rotated aliases are SELF_SMTP and use the environment prefix.
Historical `in+...` aliases are not silently reassigned to the shared domain:
rotate any such alias through the normal owner/admin flow before advertising
it. Their historical data remains intact.

Outbound invoice delivery still uses separate Resend domains/API keys and its
own delivery-event `whsec_` per environment. Subscribe only the outbound event
endpoint to sent, delivered, failed, bounced and complained events.

## Tenant activation

Every active organization member can create one personal inbound address from
Settings → Email automation. The address uses a cryptographically random
128-bit local token, is encrypted at rest, and is resolved only by its full
SHA-256 digest. It is bound to the exact organization membership, so disabling
that membership immediately stops routing. A member can copy the address,
select an authorized payables or receivables document connection, and rotate
the address; rotation retires the prior address atomically.

Mail received before document storage is selected remains encrypted and
retry-pending. Select a connected document inbox before using the address in a
normal workflow. A member must have the destination module's manage permission
to bind that connection and for the inbound worker to upload on their behalf.

Organization administrators can separately create shared aliases through the
setup MCP tools. Bind payables aliases to a payables storage connection and
receivables aliases to a receivables connection. Personal aliases are excluded
from the organization-alias administration surface. Disable or rotate any
address immediately if it is disclosed.

Start booking rules in `REVIEW_ONLY`. Move a narrowly matched supplier rule to
`CREATE_DRAFT` only after reviewing representative messages. `AUTO_POST`
requires both a trusted matching rule and the ledger's automatic-posting
policy; missing, conflicting, duplicate, ambiguous, credit-note, or incomplete
facts always go to review.

Outbound automatic delivery requires all of the following: organization
outbound and auto-send switches enabled, customer delivery method `EMAIL`,
customer auto-send enabled, at least one billing recipient, no bounce/complaint
suppression, and a posted invoice. Payment details come from the exact selected
versioned payment profile. Issuing remains committed if delivery fails; retry
the durable failed attempt after resolving the provider issue.

## Verification

Use synthetic data in a real writable development organization:

1. Confirm the Business relay route, domain MX, unique mounted secret, and
   retry-on-failure behavior; then send one PDF supplier invoice and one related receipt to a payables alias.
2. Confirm one invoice inbox item, grouped receipt evidence, immutable EMAIL
   lineage, and a review/draft outcome matching the active rule.
3. Replay the same provider event and confirm no second inbox item or bill.
4. Issue a sales invoice with automatic delivery disabled and confirm no send.
5. Enable both policies for a test customer, issue another invoice, and verify
   one deterministic PDF, one provider message, and delivered callback state.
6. Replay the issue and provider callback; confirm the artifact, attempt, and
   event are idempotent. Send a synthetic hard bounce and confirm suppression.
7. Download the issued artifact and compare its SHA-256 with stored evidence.
8. Create and rotate a personal address. Confirm the old address is ignored,
   the new address routes as that member, and disabling the membership stops
   the new address without affecting another member or shared alias.

## Incidents, retries, and retention

- Provider outage: leave failed operations durable, keep retries bounded, and
  do not rotate aliases or create new invoices merely to force a resend.
- Replay spike: disable the affected alias or organization outbound switch,
  inspect minimized operation codes and provider event IDs, then rotate the
  relevant webhook secret if authenticity is in doubt.
- Storage disconnect: reconnect the exact OneDrive connection. Attachments
  remain retry-pending or quarantined; never bypass the connection boundary.
- Unsafe attachment: only an explicit administrator action may clear
  quarantine after an external malware/content review. Encrypted, corrupt, or
  unsupported files must not enter accounting automatically.
- Bounce or complaint: correct the recipient and explicitly re-enable it in
  customer delivery preferences. A retry does not bypass suppression.
- Secret rotation: install the new file atomically, update the matching Resend
  webhook when applicable, redeploy, verify readiness and a synthetic event,
  then revoke the prior secret/key.

Run the retention action from the Email operations tool after the configured
window. It clears transient encrypted bodies and attachment bytes while
preserving hashes, immutable accounting lineage, PDFs/evidence required for
records, delivery outcomes, and minimized audit metadata. Logs and exported
audit evidence must never include raw email bodies, recipient lists,
attachments, payment instructions, provider credentials, or signing secrets.
