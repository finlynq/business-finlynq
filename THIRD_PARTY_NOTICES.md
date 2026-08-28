# Third-party notices

Business Finlynq's SimpleFIN protocol flow was adapted from the original
Finlynq project (`packages/import-connectors/src/simplefin/client.ts` and
`transform.ts`). That source is licensed under the GNU Affero General Public
License, version 3 only, and is Copyright © 2026 The Finlynq Maintainers.

The Business Finlynq implementation is substantially rewritten for an
organization-scoped accounting system and adds SSRF controls, pinned DNS,
bounded responses, exact-decimal ingestion, immutable observation versions,
formal reconciliation records, and manual-review-only categorization rules. Business
Finlynq is distributed under AGPL-3.0-or-later, which is compatible with the
upstream terms. The complete corresponding source remains available in this
repository.
