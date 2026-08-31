-- One-time Drizzle metadata rebaseline.
--
-- Migrations 0004 through 0025 were reviewed, forward-only SQL migrations
-- created while the generated snapshot chain remained at 0003. Drizzle
-- generated meta/0026_snapshot.json from the current declarations so future
-- generation compares against the complete 71-table schema. The historical
-- DDL already exists in those migrations, so replaying it here would duplicate
-- objects on both clean installs and upgrades. This migration intentionally
-- changes no database objects; its journal record advances the metadata
-- baseline only.
DO $snapshot_baseline$
BEGIN
  NULL;
END
$snapshot_baseline$;
