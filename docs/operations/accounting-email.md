# Accounting email operations

Accounting email is a tenant-scoped automation surface for inbound document
capture and outbound invoice delivery. Authentication email remains a separate
worker and credential boundary.

## Environment boundary and provider setup

Use distinct Resend domains, API keys, webhook endpoints, and signing secrets
for every environment. The hosted development contract is:

| Purpose | Development value |
| --- | --- |
| Application | `https://dev.business.finlynq.com` |
| Inbound domain | `inbound.dev.business.finlynq.com` |
| Outbound domain | `mail.dev.business.finlynq.com` |
| Inbound webhook | `https://dev.business.finlynq.com/api/email/inbound/resend` |
| Delivery-event webhook | `https://dev.business.finlynq.com/api/email/events/resend` |

Create both webhook subscriptions in the development Resend account. Subscribe
the inbound endpoint only to received-email events. Subscribe the delivery
endpoint to sent, delivered, failed, bounced, and complained events. Copy the
two independently generated `whsec_` secrets; never reuse one for both routes.

Publish the exact MX, SPF, and DKIM records supplied by Resend for the two
development subdomains. Add a monitoring-mode DMARC policy first, confirm that
legitimate traffic aligns, and then move to the organization's reviewed
enforcement policy. Do not copy development DNS records, aliases, or keys to
the production domain.

Install these single-line files as `root:business-finlynq-secrets`, mode
`0440`, outside Git:

```text
/etc/business-finlynq-dev/secrets/accounting-resend-api-key
/etc/business-finlynq-dev/secrets/accounting-email-inbound-webhook-secret
/etc/business-finlynq-dev/secrets/accounting-email-outbound-webhook-secret
```

Point `/etc/business-finlynq-dev/compose.env` at those host files and set the
public domains:

```dotenv
ACCOUNTING_EMAIL_RESEND_API_KEY_FILE=/etc/business-finlynq-dev/secrets/accounting-resend-api-key
ACCOUNTING_EMAIL_INBOUND_WEBHOOK_SECRET_FILE=/etc/business-finlynq-dev/secrets/accounting-email-inbound-webhook-secret
ACCOUNTING_EMAIL_OUTBOUND_WEBHOOK_SECRET_FILE=/etc/business-finlynq-dev/secrets/accounting-email-outbound-webhook-secret
BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN=inbound.dev.business.finlynq.com
BUSINESS_FINLYNQ_OUTBOUND_EMAIL_DOMAIN=mail.dev.business.finlynq.com
```

The app receives fixed `/run/secrets/...` paths. A missing or empty source file
keeps provider readiness disabled without exposing a secret in health output.
After changing a secret or domain, run the managed dev deployment and confirm
the Email settings page reports inbound and outbound readiness.

## Tenant activation

An organization administrator with the destination module's manage permission
creates an unguessable alias from Settings → Email automation. Bind payables
aliases to a payables OneDrive connection and receivables aliases to a
receivables connection. Alias values are encrypted at rest; routing uses only a
full SHA-256 digest. Disable or rotate an alias immediately if it is disclosed.

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

1. Send one PDF supplier invoice and one related receipt to a payables alias.
2. Confirm one invoice inbox item, grouped receipt evidence, immutable EMAIL
   lineage, and a review/draft outcome matching the active rule.
3. Replay the same provider event and confirm no second inbox item or bill.
4. Issue a sales invoice with automatic delivery disabled and confirm no send.
5. Enable both policies for a test customer, issue another invoice, and verify
   one deterministic PDF, one provider message, and delivered callback state.
6. Replay the issue and provider callback; confirm the artifact, attempt, and
   event are idempotent. Send a synthetic hard bounce and confirm suppression.
7. Download the issued artifact and compare its SHA-256 with stored evidence.

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
