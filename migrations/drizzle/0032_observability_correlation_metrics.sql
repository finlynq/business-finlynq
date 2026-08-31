-- Every immutable audit event records the exact v1 hash-material family that
-- produced its digest. The two original trigger families deliberately omit
-- safe_metadata from their material; all events written through the generic
-- tenant helper include canonical jsonb::text. The discriminator is assigned
-- from the action by a database trigger so callers cannot mislabel a digest.
ALTER TABLE public.audit_events ADD COLUMN hash_material_version text;
--> statement-breakpoint

-- The retained history is append-only to application and operator code. This
-- one migration-owned classification backfill takes an explicit table lock and
-- disables only the existing update/delete guard for the duration of the
-- transaction. PostgreSQL rolls both ALTER TRIGGER statements back if any
-- classification or hash preflight below fails.
LOCK TABLE public.audit_events IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint

ALTER TABLE public.audit_events
  DISABLE TRIGGER audit_events_append_only;
--> statement-breakpoint

UPDATE public.audit_events AS audit
SET hash_material_version = CASE audit.action
  WHEN 'journal.posted' THEN 'journal-posted-v1'
  WHEN 'period.transition' THEN 'period-transition-v1'
  ELSE 'tenant-business-v1'
END;
--> statement-breakpoint

ALTER TABLE public.audit_events
  ENABLE TRIGGER audit_events_append_only;
--> statement-breakpoint

DO $audit_hash_material_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.audit_events AS audit
    WHERE audit.event_hash IS DISTINCT FROM encode(public.digest(
      CASE audit.hash_material_version
        WHEN 'tenant-business-v1' THEN
          coalesce(audit.previous_event_hash, '') || audit.organization_id::text ||
          audit.entity_id || audit.request_id || audit.action || audit.safe_metadata::text
        WHEN 'journal-posted-v1' THEN
          coalesce(audit.previous_event_hash, '') || audit.organization_id::text ||
          audit.entity_id || audit.request_id || audit.action
        WHEN 'period-transition-v1' THEN
          coalesce(audit.previous_event_hash, '') || audit.organization_id::text ||
          audit.entity_id || audit.request_id || audit.action
        ELSE NULL
      END,
      'sha256'
    ), 'hex')
  ) THEN
    RAISE EXCEPTION 'Existing business audit history does not match its canonical hash-material contract'
      USING ERRCODE = '23514';
  END IF;
END
$audit_hash_material_preflight$;
--> statement-breakpoint

ALTER TABLE public.audit_events
  ALTER COLUMN hash_material_version SET NOT NULL,
  ADD CONSTRAINT audit_events_hash_material_version_check CHECK (
    (action = 'journal.posted' AND hash_material_version = 'journal-posted-v1')
    OR (action = 'period.transition' AND hash_material_version = 'period-transition-v1')
    OR (
      action NOT IN ('journal.posted', 'period.transition')
      AND hash_material_version = 'tenant-business-v1'
    )
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.enforce_audit_hash_material_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  expected_version text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.hash_material_version IS DISTINCT FROM OLD.hash_material_version THEN
      RAISE EXCEPTION 'Business audit hash-material version is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  expected_version := CASE NEW.action
    WHEN 'journal.posted' THEN 'journal-posted-v1'
    WHEN 'period.transition' THEN 'period-transition-v1'
    ELSE 'tenant-business-v1'
  END;
  IF NEW.hash_material_version IS NOT NULL
    AND NEW.hash_material_version <> expected_version
  THEN
    RAISE EXCEPTION 'Business audit hash-material version does not match its action contract'
      USING ERRCODE = '22023';
  END IF;
  NEW.hash_material_version := expected_version;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.enforce_audit_hash_material_version() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER audit_events_hash_material_version
  BEFORE INSERT OR UPDATE OF hash_material_version ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.enforce_audit_hash_material_version();
--> statement-breakpoint

-- This owner-only, versioned catalog is the single live contract for business
-- events that require both immutable audit evidence and one transactional
-- outbox message. Actions absent from this table remain legitimate audit-only
-- actions (for example accounting configuration, hierarchies, and banking).
CREATE TABLE public.audit_outbox_pair_contract (
  audit_action text PRIMARY KEY,
  outbox_topic text NOT NULL,
  aggregate_type text NOT NULL,
  contract_version text NOT NULL,
  CONSTRAINT audit_outbox_pair_contract_topic_aggregate_unique
    UNIQUE (outbox_topic, aggregate_type),
  CONSTRAINT audit_outbox_pair_contract_version_check
    CHECK (contract_version = 'business-audit-outbox-v1'),
  CONSTRAINT audit_outbox_pair_contract_names_check CHECK (
    length(audit_action) BETWEEN 1 AND 120
    AND length(outbox_topic) BETWEEN 1 AND 120
    AND length(aggregate_type) BETWEEN 1 AND 120
    AND audit_action !~ E'[\\r\\n]'
    AND outbox_topic !~ E'[\\r\\n]'
    AND aggregate_type !~ E'[\\r\\n]'
  )
);
REVOKE ALL ON TABLE public.audit_outbox_pair_contract FROM PUBLIC;
--> statement-breakpoint

INSERT INTO public.audit_outbox_pair_contract(
  audit_action, outbox_topic, aggregate_type, contract_version
) VALUES
  ('journal.draft-created', 'ledger.journal-draft-created', 'journal_entry', 'business-audit-outbox-v1'),
  ('journal.posted', 'ledger.journal-posted', 'journal_entry', 'business-audit-outbox-v1'),
  ('journal.reversed', 'ledger.journal-reversed', 'journal_entry', 'business-audit-outbox-v1'),
  ('period.transition', 'ledger.period-transitioned', 'fiscal_period', 'business-audit-outbox-v1'),
  ('party.created', 'parties.party-created', 'party', 'business-audit-outbox-v1'),
  ('subledger.allocation-applied', 'subledger.settlement-allocation-apply', 'document_settlement_allocation', 'business-audit-outbox-v1'),
  ('subledger.allocation-reversed', 'subledger.settlement-allocation-reversal', 'document_settlement_allocation', 'business-audit-outbox-v1'),
  ('subledger.open-item-voided', 'subledger.open-item-void', 'open_item_void_event', 'business-audit-outbox-v1'),
  ('receivables.document-drafted', 'receivables.source-document-draft', 'source_document', 'business-audit-outbox-v1'),
  ('receivables.document-posted', 'receivables.source-document-posted', 'source_document', 'business-audit-outbox-v1'),
  ('receivables.document-voided', 'receivables.source-document-voided', 'source_document', 'business-audit-outbox-v1'),
  ('payables.document-drafted', 'payables.source-document-draft', 'source_document', 'business-audit-outbox-v1'),
  ('payables.document-posted', 'payables.source-document-posted', 'source_document', 'business-audit-outbox-v1'),
  ('payables.document-voided', 'payables.source-document-voided', 'source_document', 'business-audit-outbox-v1'),
  ('organization.settings-updated', 'organization.settings-updated', 'organization', 'business-audit-outbox-v1'),
  ('organization.member-invited', 'organization.member-invited', 'organization_membership', 'business-audit-outbox-v1'),
  ('organization.invitation-reissued', 'organization.invitation-reissued', 'organization_membership', 'business-audit-outbox-v1'),
  ('organization.invitation-cancelled', 'organization.invitation-cancelled', 'organization_membership', 'business-audit-outbox-v1'),
  ('organization.member-role-changed', 'organization.member-role-changed', 'organization_membership', 'business-audit-outbox-v1'),
  ('organization.member-reactivated', 'organization.member-reactivated', 'organization_membership', 'business-audit-outbox-v1'),
  ('organization.member-suspended', 'organization.member-suspended', 'organization_membership', 'business-audit-outbox-v1'),
  ('organization.member-sessions-revoked', 'organization.member-sessions-revoked', 'organization_membership', 'business-audit-outbox-v1'),
  ('organization.writes-enabled', 'organization.writes-enabled', 'organization', 'business-audit-outbox-v1'),
  ('organization.writes-disabled', 'organization.writes-disabled', 'organization', 'business-audit-outbox-v1');
--> statement-breakpoint

CREATE POLICY audit_outbox_pair_contract_owner_only_policy
  ON public.audit_outbox_pair_contract
  FOR ALL TO PUBLIC
  USING (
    current_user = pg_catalog.pg_get_userbyid((
      SELECT owner_relation.relowner
      FROM pg_catalog.pg_class AS owner_relation
      WHERE owner_relation.oid = 'public.audit_outbox_pair_contract'::pg_catalog.regclass
    ))
  )
  WITH CHECK (
    current_user = pg_catalog.pg_get_userbyid((
      SELECT owner_relation.relowner
      FROM pg_catalog.pg_class AS owner_relation
      WHERE owner_relation.oid = 'public.audit_outbox_pair_contract'::pg_catalog.regclass
    ))
  );
ALTER TABLE public.audit_outbox_pair_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_outbox_pair_contract FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- G0-05 request correlation is durable: every new business outbox record uses
-- the same bounded request key already written to its audit event. G0-03 makes
-- audit occurrence time monotonic with clock_timestamp(), while outbox time
-- remains transaction-stable. G0-03 therefore adds this nullable column and
-- writes exact request keys before changing the audit clock. Only NULL history
-- from before G0-03 is eligible for the timestamp-based paired-event backfill.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.outbox_events'::pg_catalog.regclass
      AND attribute.attname = 'request_id'
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'G0-05 requires the G0-03 nullable outbox request-correlation bridge'
      USING ERRCODE = '55000';
  END IF;
END
$$;
--> statement-breakpoint

-- BEGIN OUTBOX REQUEST CORRELATION BACKFILL
WITH paired_events(action, topic, aggregate_type) AS (
  SELECT contract.audit_action, contract.outbox_topic, contract.aggregate_type
  FROM public.audit_outbox_pair_contract AS contract
  WHERE contract.contract_version = 'business-audit-outbox-v1'
), candidate_pairs AS (
  SELECT
    outbox.id AS outbox_id,
    audit.request_id,
    count(*) OVER (PARTITION BY outbox.id) AS candidate_count
  FROM public.outbox_events AS outbox
  JOIN paired_events AS pair
    ON pair.topic = outbox.topic
   AND pair.aggregate_type = outbox.aggregate_type
  JOIN public.audit_events AS audit
    ON audit.organization_id = outbox.organization_id
   AND audit.entity_type = outbox.aggregate_type
   AND audit.entity_id = outbox.aggregate_id
   AND audit.action = pair.action
   AND audit.occurred_at = outbox.created_at
  WHERE outbox.request_id IS NULL
    AND (
      audit.safe_metadata <@ outbox.payload
      OR (
        pair.action = 'period.transition'
        AND audit.safe_metadata->>'from' = outbox.payload->>'fromState'
        AND audit.safe_metadata->>'to' = outbox.payload->>'toState'
        AND audit.safe_metadata->'version' = outbox.payload->'version'
      )
    )
), unique_candidates AS (
  SELECT candidate.outbox_id, candidate.request_id
  FROM candidate_pairs AS candidate
  WHERE candidate.candidate_count = 1
)
UPDATE public.outbox_events AS outbox
SET request_id = candidate.request_id
FROM unique_candidates AS candidate
WHERE candidate.outbox_id = outbox.id;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.outbox_events AS outbox
    WHERE outbox.request_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Existing business outbox history cannot be correlated unambiguously to audit evidence'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.outbox_events AS outbox
    LEFT JOIN public.audit_outbox_pair_contract AS contract
      ON contract.outbox_topic = outbox.topic
     AND contract.aggregate_type = outbox.aggregate_type
     AND contract.contract_version = 'business-audit-outbox-v1'
    WHERE contract.audit_action IS NULL
  ) THEN
    RAISE EXCEPTION 'Existing business outbox history contains an unknown topic or aggregate contract'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.outbox_events AS outbox
    JOIN public.audit_outbox_pair_contract AS contract
      ON contract.outbox_topic = outbox.topic
     AND contract.aggregate_type = outbox.aggregate_type
     AND contract.contract_version = 'business-audit-outbox-v1'
    WHERE (
      SELECT count(*)
      FROM public.audit_events AS audit
      WHERE audit.organization_id = outbox.organization_id
        AND audit.request_id = outbox.request_id
        AND audit.action = contract.audit_action
        AND audit.entity_type = contract.aggregate_type
        AND audit.entity_id = outbox.aggregate_id
    ) <> 1
  ) THEN
    RAISE EXCEPTION 'Existing business outbox history lacks exactly one correct audit event'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.audit_events AS audit
    JOIN public.audit_outbox_pair_contract AS contract
      ON contract.audit_action = audit.action
     AND contract.contract_version = 'business-audit-outbox-v1'
    WHERE audit.entity_type <> contract.aggregate_type
      OR (
        SELECT count(*)
        FROM public.outbox_events AS outbox
        WHERE outbox.organization_id = audit.organization_id
          AND outbox.request_id = audit.request_id
          AND outbox.topic = contract.outbox_topic
          AND outbox.aggregate_type = contract.aggregate_type
          AND outbox.aggregate_id = audit.entity_id
      ) <> 1
  ) THEN
    RAISE EXCEPTION 'Existing paired audit history lacks exactly one correct outbox event'
      USING ERRCODE = '23514';
  END IF;
END
$$;
-- END OUTBOX REQUEST CORRELATION BACKFILL
--> statement-breakpoint

ALTER TABLE public.outbox_events
  ALTER COLUMN request_id SET NOT NULL,
  ADD CONSTRAINT outbox_events_topic_aggregate_contract_fk
    FOREIGN KEY (topic, aggregate_type)
    REFERENCES public.audit_outbox_pair_contract(outbox_topic, aggregate_type)
    ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint

CREATE UNIQUE INDEX outbox_events_audit_pair_unique
  ON public.outbox_events USING btree (
    organization_id, request_id, topic, aggregate_type, aggregate_id
  );
--> statement-breakpoint

CREATE INDEX outbox_events_org_request_idx
  ON public.outbox_events USING btree (organization_id, request_id);
--> statement-breakpoint

CREATE INDEX outbox_events_unpublished_created_idx
  ON public.outbox_events USING btree (published_at, created_at);
--> statement-breakpoint

CREATE INDEX outbox_events_created_idx
  ON public.outbox_events USING btree (created_at);
--> statement-breakpoint

CREATE INDEX outbox_events_legacy_request_idx
  ON public.outbox_events USING btree (request_id)
  WHERE request_id LIKE 'legacy:%';
--> statement-breakpoint

CREATE INDEX auth_email_outbox_sent_at_idx
  ON public.auth_email_outbox USING btree (sent_at)
  WHERE status = 'SENT';
--> statement-breakpoint

CREATE INDEX auth_email_outbox_delivery_dead_idx
  ON public.auth_email_outbox USING btree (created_at)
  WHERE status = 'DEAD'
    AND upper(coalesce(last_error_code, '')) NOT IN (
      'CANCELLED',
      'INVALIDATED_BY_MFA_ENROLLMENT',
      'SUPERSEDED',
      'SUPERSEDED_BY_INVITATION',
      'SUPERSEDED_BY_SIGNUP'
    );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.enforce_outbox_request_correlation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  request_context text;
  expected_action text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.topic IS DISTINCT FROM OLD.topic
      OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
      OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
      OR NEW.request_id IS DISTINCT FROM OLD.request_id
    THEN
      RAISE EXCEPTION 'Business outbox audit-correlation fields are immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  SELECT contract.audit_action INTO expected_action
  FROM public.audit_outbox_pair_contract AS contract
  WHERE contract.outbox_topic = NEW.topic
    AND contract.aggregate_type = NEW.aggregate_type
    AND contract.contract_version = 'business-audit-outbox-v1';
  IF expected_action IS NULL THEN
    RAISE EXCEPTION 'Business outbox topic or aggregate type is outside the versioned contract'
      USING ERRCODE = '23503';
  END IF;

  request_context := nullif(pg_catalog.current_setting('app.request_id', true), '');
  IF request_context IS NULL THEN
    -- Posting may contractually use its immutable idempotency key when no edge
    -- request context exists. No other event family may use this fallback, and
    -- the exact explicit key still has to select the matching posting audit.
    IF NEW.topic <> 'ledger.journal-posted' OR NEW.request_id IS NULL THEN
      RAISE EXCEPTION 'Only journal posting may use an explicit request key without transaction context'
        USING ERRCODE = '22023';
    END IF;
    request_context := NEW.request_id;
  END IF;
  IF request_context IS NULL OR length(request_context) NOT BETWEEN 1 AND 200
    OR request_context ~ E'[\\r\\n]'
  THEN
    RAISE EXCEPTION 'Business outbox insert requires a bounded request context'
      USING ERRCODE = '22023';
  END IF;
  IF NEW.request_id IS NOT NULL AND NEW.request_id <> request_context THEN
    RAISE EXCEPTION 'Business outbox request correlation does not match its transaction context'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.audit_events AS audit
    WHERE audit.organization_id = NEW.organization_id
      AND audit.request_id = request_context
      AND audit.action = expected_action
      AND audit.entity_type = NEW.aggregate_type
      AND audit.entity_id = NEW.aggregate_id
  ) THEN
    RAISE EXCEPTION 'Business outbox insert requires matching durable audit evidence'
      USING ERRCODE = '23503';
  END IF;

  NEW.request_id := request_context;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.enforce_outbox_request_correlation() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER outbox_events_request_correlation
  BEFORE INSERT OR UPDATE OF organization_id, topic, aggregate_type, aggregate_id, request_id
  FOR EACH ROW EXECUTE FUNCTION app.enforce_outbox_request_correlation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.enforce_paired_audit_outbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  expected_topic text;
  expected_aggregate_type text;
  paired_outbox_count bigint;
BEGIN
  SELECT contract.outbox_topic, contract.aggregate_type
    INTO expected_topic, expected_aggregate_type
  FROM public.audit_outbox_pair_contract AS contract
  WHERE contract.audit_action = NEW.action
    AND contract.contract_version = 'business-audit-outbox-v1';

  -- The absence of a contract row deliberately means this action is audit-only.
  IF expected_topic IS NULL THEN
    RETURN NULL;
  END IF;
  IF NEW.entity_type <> expected_aggregate_type THEN
    RAISE EXCEPTION 'Paired audit action does not use its contracted aggregate type'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO paired_outbox_count
  FROM public.outbox_events AS outbox
  WHERE outbox.organization_id = NEW.organization_id
    AND outbox.request_id = NEW.request_id
    AND outbox.topic = expected_topic
    AND outbox.aggregate_type = expected_aggregate_type
    AND outbox.aggregate_id = NEW.entity_id;
  IF paired_outbox_count <> 1 THEN
    RAISE EXCEPTION 'Paired audit event requires exactly one contracted outbox event'
      USING ERRCODE = '23503';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.enforce_paired_audit_outbox() FROM PUBLIC;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER audit_events_required_outbox
  AFTER INSERT ON public.audit_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.enforce_paired_audit_outbox();
--> statement-breakpoint

-- The web role receives one aggregate-only function. No tenant, user, address,
-- journal, currency, amount, free text, topic, or provider error label crosses
-- this boundary.
CREATE OR REPLACE FUNCTION app.operations_metrics()
RETURNS TABLE(
  observed_at timestamp with time zone,
  auth_failures_5m bigint,
  auth_failures_1h bigint,
  outbox_unpublished_count bigint,
  outbox_oldest_unpublished_at timestamp with time zone,
  outbox_legacy_request_count bigint,
  outbox_unmatched_audit_count bigint,
  email_pending_count bigint,
  email_sending_count bigint,
  email_dead_count bigint,
  email_sent_5m bigint,
  email_failures_5m bigint,
  email_oldest_due_at timestamp with time zone,
  email_worker_last_heartbeat_at timestamp with time zone,
  demo_slots_total bigint,
  demo_slots_ready bigint,
  demo_slots_assigned bigint,
  demo_slots_dirty bigint,
  demo_slots_resetting bigint,
  demo_slots_quarantined bigint,
  demo_pool_reset_due boolean,
  demo_last_completed_reset_at timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH auth_state AS (
    SELECT
      (SELECT count(*)::bigint FROM public.auth_security_events AS event
       WHERE event.created_at >= pg_catalog.statement_timestamp() - interval '5 minutes'
         AND event.outcome IN ('FAILURE', 'DENIED')) AS failures_5m,
      (SELECT count(*)::bigint FROM public.auth_security_events AS event
       WHERE event.created_at >= pg_catalog.statement_timestamp() - interval '1 hour'
         AND event.outcome IN ('FAILURE', 'DENIED')) AS failures_1h,
      (SELECT count(*)::bigint FROM public.auth_security_events AS event
       WHERE event.created_at >= pg_catalog.statement_timestamp() - interval '5 minutes'
         AND event.event_type = 'EMAIL_DELIVERY'
         AND event.outcome = 'FAILURE') AS email_failures_5m
  ), outbox_state AS (
    SELECT
      (SELECT count(*)::bigint FROM public.outbox_events AS outbox
       WHERE outbox.published_at IS NULL) AS unpublished_count,
      (SELECT min(outbox.created_at) FROM public.outbox_events AS outbox
       WHERE outbox.published_at IS NULL) AS oldest_unpublished_at,
      (SELECT count(*)::bigint FROM public.outbox_events AS outbox
       WHERE outbox.request_id LIKE 'legacy:%') AS legacy_request_count,
      (SELECT count(*)::bigint
       FROM (
         SELECT audit.id
         FROM public.audit_events AS audit
         JOIN public.audit_outbox_pair_contract AS contract
           ON contract.audit_action = audit.action
          AND contract.contract_version = 'business-audit-outbox-v1'
         WHERE audit.occurred_at >= pg_catalog.statement_timestamp() - interval '1 hour'
           AND (
             audit.entity_type IS DISTINCT FROM contract.aggregate_type
             OR (
               SELECT count(*)
               FROM public.outbox_events AS outbox
               WHERE outbox.organization_id = audit.organization_id
                 AND outbox.request_id = audit.request_id
                 AND outbox.topic = contract.outbox_topic
                 AND outbox.aggregate_type = contract.aggregate_type
                 AND outbox.aggregate_id = audit.entity_id
             ) <> 1
           )
         UNION ALL
         SELECT outbox.id
         FROM public.outbox_events AS outbox
         LEFT JOIN public.audit_outbox_pair_contract AS contract
           ON contract.outbox_topic = outbox.topic
          AND contract.aggregate_type = outbox.aggregate_type
          AND contract.contract_version = 'business-audit-outbox-v1'
         WHERE outbox.created_at >= pg_catalog.statement_timestamp() - interval '1 hour'
           AND (
             contract.audit_action IS NULL
             OR (
               SELECT count(*)
               FROM public.audit_events AS audit
               WHERE audit.organization_id = outbox.organization_id
                 AND audit.request_id = outbox.request_id
                 AND audit.action = contract.audit_action
                 AND audit.entity_type = contract.aggregate_type
                 AND audit.entity_id = outbox.aggregate_id
             ) <> 1
           )
       ) AS correlation_anomaly) AS unmatched_audit_count
  ), email_state AS (
    SELECT
      (SELECT count(*)::bigint FROM public.auth_email_outbox AS email
       WHERE email.status = 'PENDING') AS pending_count,
      (SELECT count(*)::bigint FROM public.auth_email_outbox AS email
       WHERE email.status = 'SENDING') AS sending_count,
      (SELECT count(*)::bigint
       FROM public.auth_email_outbox AS email
       WHERE email.status = 'DEAD'
         AND email.created_at >= pg_catalog.statement_timestamp() - interval '1 hour'
         AND upper(coalesce(email.last_error_code, '')) NOT IN (
           'CANCELLED',
           'INVALIDATED_BY_MFA_ENROLLMENT',
           'SUPERSEDED',
           'SUPERSEDED_BY_INVITATION',
           'SUPERSEDED_BY_SIGNUP'
         )) AS dead_count,
      (SELECT count(*)::bigint FROM public.auth_email_outbox AS email
       WHERE email.status = 'SENT'
         AND email.sent_at >= pg_catalog.statement_timestamp() - interval '5 minutes') AS sent_5m,
      (SELECT min(due.created_at)
       FROM (
         SELECT email.created_at
         FROM public.auth_email_outbox AS email
         WHERE email.status = 'PENDING'
           AND email.available_at <= pg_catalog.statement_timestamp()
         UNION ALL
         SELECT email.created_at
         FROM public.auth_email_outbox AS email
         WHERE email.status = 'SENDING'
           AND email.lease_expires_at < pg_catalog.statement_timestamp()
       ) AS due) AS oldest_due_at
  ), worker_state AS (
    SELECT max(worker.last_heartbeat_at) AS last_heartbeat_at
    FROM public.auth_email_worker_status AS worker
  ), demo_state AS (
    SELECT
      count(*)::bigint AS slots_total,
      count(*) FILTER (WHERE slot.state = 'READY')::bigint AS slots_ready,
      count(*) FILTER (WHERE slot.state = 'ASSIGNED')::bigint AS slots_assigned,
      count(*) FILTER (WHERE slot.state = 'DIRTY')::bigint AS slots_dirty,
      count(*) FILTER (WHERE slot.state = 'RESETTING')::bigint AS slots_resetting,
      count(*) FILTER (WHERE slot.state = 'QUARANTINED')::bigint AS slots_quarantined
    FROM public.demo_sandbox_slots AS slot
  ), pool_state AS (
    SELECT
      coalesce(pool.reset_after <= pg_catalog.statement_timestamp(), true) AS reset_due,
      pool.last_completed_reset_at
    FROM public.demo_sandbox_pool AS pool
    WHERE pool.singleton
  )
  SELECT
    pg_catalog.statement_timestamp(),
    auth_state.failures_5m,
    auth_state.failures_1h,
    outbox_state.unpublished_count,
    outbox_state.oldest_unpublished_at,
    outbox_state.legacy_request_count,
    outbox_state.unmatched_audit_count,
    email_state.pending_count,
    email_state.sending_count,
    email_state.dead_count,
    email_state.sent_5m,
    auth_state.email_failures_5m,
    email_state.oldest_due_at,
    worker_state.last_heartbeat_at,
    demo_state.slots_total,
    demo_state.slots_ready,
    demo_state.slots_assigned,
    demo_state.slots_dirty,
    demo_state.slots_resetting,
    demo_state.slots_quarantined,
    coalesce(pool_state.reset_due, true),
    pool_state.last_completed_reset_at
  FROM auth_state
  CROSS JOIN outbox_state
  CROSS JOIN email_state
  CROSS JOIN worker_state
  CROSS JOIN demo_state
  LEFT JOIN pool_state ON true
$$;
REVOKE ALL ON FUNCTION app.operations_metrics() FROM PUBLIC;
--> statement-breakpoint

DO $observability_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'business_finlynq_app') THEN
    REVOKE ALL ON TABLE public.audit_outbox_pair_contract FROM business_finlynq_app;
    GRANT EXECUTE ON FUNCTION app.operations_metrics() TO business_finlynq_app;
    REVOKE EXECUTE ON FUNCTION
      app.enforce_audit_hash_material_version(),
      app.enforce_outbox_request_correlation(),
      app.enforce_paired_audit_outbox()
      FROM business_finlynq_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'business_finlynq_auth_worker') THEN
    REVOKE ALL ON TABLE public.audit_outbox_pair_contract FROM business_finlynq_auth_worker;
    REVOKE EXECUTE ON FUNCTION
      app.operations_metrics(),
      app.enforce_audit_hash_material_version(),
      app.enforce_outbox_request_correlation(),
      app.enforce_paired_audit_outbox()
    FROM business_finlynq_auth_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'business_finlynq_backup') THEN
    GRANT SELECT ON TABLE public.audit_outbox_pair_contract TO business_finlynq_backup;
    REVOKE EXECUTE ON FUNCTION
      app.operations_metrics(),
      app.enforce_audit_hash_material_version(),
      app.enforce_outbox_request_correlation(),
      app.enforce_paired_audit_outbox()
    FROM business_finlynq_backup;
  END IF;
END
$observability_grants$;
