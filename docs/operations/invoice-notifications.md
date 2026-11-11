# Received invoice reminders for agents

On MCP initialization/discovery and `finlynq_connection_capabilities`, an
eligible connection receives the current organization’s outstanding emailed
invoice summary. `finlynq_daily_get_invoice_notifications` and the JSON resource
`finlynq://inbox/payables/email` expose the same read-only state.

The summary counts distinct invoice documents and distinct emails separately.
It groups ready work, review work, active claims, pending intake and failed
intake. Supporting receipts and duplicate content are excluded. An invoice
already converted to a draft or completed by filing is excluded even if that
draft has not yet been posted. Active claims are visible without prompting
another agent to process them. Expired claims return to the actionable count.
Source failures return `UNAVAILABLE` without fabricated zero counts.

Counts cover the entire outstanding set. At most 25 item references are returned;
`itemsTruncated` identifies a longer list. Use the normal inbox list to page
through documents. The notification query does not read email bodies, subjects,
addresses, filenames or document bytes. A notice never claims a document,
creates a draft, posts an entry or authorizes a write.

## During an active session

Hosts supporting MCP revision `2026-07-28` should keep a `subscriptions/listen`
request open with this filter:

```json
{"notifications":{"resourceSubscriptions":["finlynq://inbox/payables/email"]}}
```

Send the normal protocol `_meta` envelope with client information/capabilities,
`MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: subscriptions/listen`, and an
Accept header allowing `text/event-stream`. The SDK acknowledges the
subscription before delivering `notifications/resources/updated`. On each
update, reread the resource and show a concise reminder if `shouldNotify` is
true. Deduplicate reminders by the organization-scoped `revision`.

The server checks durable email/inbox state every 15 seconds. New received
invoice candidates therefore become visible within one refresh interval plus
query time under normal operation; scanning/provider intake may still be
pending. The same read detects invoices written by another worker or process.
Processing or review changes also emit an update so the displayed count stays
current. Unchanged state and provider callback retries do not emit duplicates.
No subscription or acknowledgment removes work from the inbox.

Bearer validity and live connection/permission state are rechecked on each
refresh. Each subscription has its own organization/connection-bound bus;
there is no cross-tenant broadcast. Disconnect, cancellation, revocation and
expiry release the polling timer. Streams close after 14 minutes and hosts must
resubscribe with current credentials. The process permits four streams per
connection and 128 overall; excess requests receive HTTP 429 with Retry-After.

## Clients without subscription support

MCP resource notifications require host support; the server cannot wake a
passive chat whose host neither listens nor polls. The existing stateless
2025-era MCP transport does not provide unsolicited GET/SSE notifications.
The advertised fallback is for the host to call
`finlynq_daily_get_invoice_notifications` every 15 seconds while active, passing
its last `afterRevision`. `observedAt` and `refreshAfterMs` expose freshness;
an unchanged revision sets `shouldNotify: false`. Omit the cursor when retrying
an unavailable source. Reconnecting always recovers the current backlog.

Verify the intended production client’s subscription/polling and user-prompt
behavior before claiming that it supports background alerts. Automated tests
exercise actual SDK subscription delivery and cancellation, but cannot enable
this behavior in an external client.

Protocol reference: [MCP resource subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/server/resources#subscriptions).
