# Completed document filing recovery

Accounting completion saves the original inbox item, evidence asset, content hash,
and archive destination before cloud filing begins. Retry filing on that existing
item; do not recreate accounting, upload another copy, or rebook a journal.

The API, MCP status tool and inbox show the saved filing state: QUEUED, RUNNING,
RETRY_WAIT, STALLED, FAILED or FILED, with attempt count, stage, actual last
progress, heartbeat and next retry time. A queued response does not mean that a
worker has started. A heartbeat shows liveness; progress changes at checkpoints.

The application worker checks durable work every 15 seconds when writes are
enabled. It rechecks the original actor's current membership, module permission,
organization and active connection. Each connection admits up to three filing
attempts. Database locks cover admission/checkpoints, never provider I/O.

An attempt has a 120-second deadline and a renewable 150-second claim. Heartbeats
run every 20 seconds; status reports a stale heartbeat after 45 seconds. An
expired claim can be recovered after a process restart. Work queued for ten
minutes without progress is displayed as stalled. A late attempt must still own
its unexpired token before moving or committing status.

Transient failures retry at 60, 120, 240, 480 and 900 seconds. Provider Retry-After
can extend a delay up to one hour. Six attempts exhaust automatic retries.
Explicit retry of failed work starts a new bounded attempt budget; live claims
and scheduled backoff cannot be bypassed. Reconnect/restore original storage or
resolve permissions before retrying a permanent refusal. The queue logs a
minimized authorization blocker when the saved actor is no longer eligible.

A move whose response or final database write was lost is reconciled using the
same provider file ID, saved destination, canonical name and original hash. The
worker verifies archived bytes before marking FILED. It never creates another
evidence asset or changes the linked accounting. Provider logs contain safe
status/request IDs and stage, without credentials, document bytes or raw errors.

Source and disposable database verification do not establish that incident
originals have been filed in production. Confirm their existing asset IDs and
hashes after the separately qualified release, and retain live acceptance in the
ticket.
