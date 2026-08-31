-- Manual allocations are append-only financial evidence. Bind every client
-- retry key to one reconciliation and preserve a durable versioned fingerprint
-- so replay cannot create a second allocation or silently change its facts.
ALTER TABLE bank_match_allocations
  ADD COLUMN idempotency_key text,
  ADD COLUMN command_hash text;
--> statement-breakpoint

-- Pre-0028 allocations did not retain a request identity. Reserve a synthetic
-- key for each one so uniqueness is forward-safe without making legacy rows
-- replayable by client requests. The table is already protected by named
-- BEFORE UPDATE guards; suspend only those two guards for this owner-run
-- backfill and restore them before the statement group completes.
ALTER TABLE bank_match_allocations DISABLE TRIGGER banking_permission_guard;
ALTER TABLE bank_match_allocations DISABLE TRIGGER bank_immutable_record;
--> statement-breakpoint

UPDATE bank_match_allocations
SET idempotency_key = 'legacy-bank-match:' || id::text,
    command_hash = 'legacy-bank-match:' || id::text
WHERE idempotency_key IS NULL OR command_hash IS NULL;
--> statement-breakpoint

ALTER TABLE bank_match_allocations ENABLE TRIGGER banking_permission_guard;
ALTER TABLE bank_match_allocations ENABLE TRIGGER bank_immutable_record;
--> statement-breakpoint

ALTER TABLE bank_match_allocations
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN command_hash SET NOT NULL,
  ADD CONSTRAINT bank_match_allocations_idempotency_key_length
    CHECK (length(idempotency_key) BETWEEN 1 AND 180),
  ADD CONSTRAINT bank_match_allocations_command_hash_sha256
    CHECK (command_hash ~ '^(?:[0-9a-f]{64}|legacy-bank-match:[0-9a-f-]{36})$');
--> statement-breakpoint

CREATE UNIQUE INDEX bank_match_allocations_org_session_idempotency_unique
  ON bank_match_allocations(organization_id, reconciliation_session_id, idempotency_key);
--> statement-breakpoint

COMMENT ON COLUMN bank_match_allocations.idempotency_key IS
  'Client-supplied bounded idempotency key, unique within the organization reconciliation session.';
--> statement-breakpoint

COMMENT ON COLUMN bank_match_allocations.command_hash IS
  'Versioned canonical fingerprint of reconciliation ID, observation version ID, journal line ID, and exact allocated amount.';
