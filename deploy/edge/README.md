# Business Finlynq shared-edge boundary

Shared-edge contract v1 makes `/home/ubuntu/finlynq-shared-edge` the sole
future owner of the public Caddy process, ports, configuration, certificates,
headers, logs, and edge deployment. Business Finlynq owns only its application
services and these stable interfaces:

- `business_finlynq_edge` -> `production-app:3000`
- `business_finlynq_development_edge` -> `development-app:3000`

`verify-external-edge.sh` performs read-only central identity, Business
network, Business runtime, and Business public-route checks. The compatibility
`reconcile-shared-edge.sh` name also performs verification only.

The production release runner has one explicit forward-repair boundary. It
binds verification to the root-owned recovery journal's exact SHA-256 digest,
requires the durable router state and public route to remain in maintenance,
and accepts at most one stopped, hardened app anchor matching the journaled
source or immutable candidate. Normal verification still requires one running,
healthy app. This boundary never changes or reloads the central edge.

The files below are retained unchanged as rollback input for the old edge until
the centrally approved rollback window closes. They are not referenced by
current application deployment or rollback paths:

- `Caddyfile.business-external`
- `docker-compose.external.yml`
- `../Caddyfile.container`
- `../Caddyfile.example`
- `legacy/reconcile-shared-edge-v0.sh`

Retiring that rollback material requires a separate approved cleanup after the
central cutover. Business Finlynq must never activate it on its own.
