# Interactive shared demo

The public demo is one shared, writable accounting organization backed by the same accounting services, database controls, and transaction workflows used by ordinary organizations. It is not allocated per browser. Every visitor enters Northstar Demo Group, so two visitors can see and affect the same invoices, bills, journals, parties, reconciliation work, settings, and reports.

All demo data is synthetic and temporary. Nightly maintenance revokes open demo sessions, deletes organization-owned business data, restores the canonical identity and settings, reseeds the verified accounting baseline, and advances the next reset boundary. The scheduled boundary is 04:15 America/Toronto.

## Access and feature gates

Demo access remains controlled by DEMO_LOGIN_ENABLED; demo mutations require DEMO_WRITES_ENABLED. Real account login, signup, writes, and external bank feeds retain their independent gates. A live demo-link session is valid only for the fixed PUBLIC_DEMO organization and current canonical demo membership.

The shared demo uses the normal accounting write paths and database permissions for chart-of-accounts changes, parties, journals, AR/AP documents, payments, receipts, reconciliations, period operations, and reports. Anonymous-demo safety boundaries still prevent recovery administration, real provider credentials, external email delivery, and delegated MCP/OAuth connections. These boundaries prevent a public visitor from gaining control over real identities or third-party systems.

## Session and concurrency model

- /try-demo creates a short-lived, user-agent-bound session for the fixed shared organization.
- There is no browser claim cookie, slot, generation, lease handoff, pool capacity, or per-IP allocation ceiling.
- Multiple visitors may hold live sessions at the same time and all resolve to the same organization and canonical demo user.
- Signing out revokes only that browser session and does not undo business changes.
- New visitors see changes left by earlier visitors until the next reset.
- Route-level burst controls still protect the public entry endpoint.

## Reset consistency

Every demo transaction takes a shared advisory fence before organization work begins. The nightly reset takes the exclusive side of the same fence, so reset cannot race an in-flight accounting transaction. During reset the durable shared_demo_reset_state row is RESETTING; new demo sessions fail closed. A successful verified reseed changes it to READY. Any failure records FAILED, keeps entry closed, and requires a repaired rerun.

The reset purges every registered organization-owned table child-first, runs app.reset_shared_demo_extensions for identity and cross-tenant cleanup, reseeds encrypted fixtures under the existing organization key, posts issued fixtures through production posting controls, and verifies exact baseline counts before reopening access.

## Release acceptance

Acceptance must prove:

- two clean browser contexts enter the same organization;
- a transaction created in one context becomes visible in the other;
- logout and re-entry do not erase shared changes;
- AR/AP issue, settlement, void, journal, reconciliation, setup, and reporting paths still use normal controls;
- unique acceptance document numbers allow safe retries before nightly reset;
- the reset revokes all visitor sessions and restores the exact baseline;
- no browser console errors, failed requests, cross-origin leaks, or public reset authority are present.

See [demo-sandbox-maintenance.md](demo-sandbox-maintenance.md) for the operator procedure. The filename remains stable for existing runbook links during the compatibility release.
