-- A session advisory lock serializes this intentionally full-history verifier.
-- The caller applies a hard statement_timeout, including time spent waiting.
DO $$
BEGIN
  PERFORM pg_catalog.pg_advisory_lock(
    pg_catalog.hashtextextended('business-finlynq-accounting-evidence-v1', 0)
  );
END
$$;

WITH RECURSIVE
target_organizations AS (
  SELECT DISTINCT audit.organization_id
  FROM public.audit_events AS audit
),
audit_hash_contract AS (
  SELECT
    audit.id,
    coalesce(CASE
      WHEN audit.action = 'journal.posted'
        THEN audit.hash_material_version = 'journal-posted-v1'
      WHEN audit.action = 'period.transition'
        THEN audit.hash_material_version = 'period-transition-v1'
      ELSE audit.hash_material_version = 'tenant-business-v1'
    END, false) AS contract_valid,
    encode(public.digest(
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
    ), 'hex') AS expected_event_hash,
    audit.event_hash
  FROM public.audit_events AS audit
),
chain_roots AS (
  SELECT audit.organization_id, audit.event_hash
  FROM public.audit_events AS audit
  WHERE audit.previous_event_hash IS NULL
),
reachable_events(organization_id, event_hash) AS (
  SELECT root.organization_id, root.event_hash
  FROM chain_roots AS root
  UNION
  SELECT child.organization_id, child.event_hash
  FROM reachable_events AS parent
  JOIN public.audit_events AS child
    ON child.organization_id = parent.organization_id
   AND child.previous_event_hash = parent.event_hash
),
root_anomalies AS (
  SELECT organization.organization_id
  FROM target_organizations AS organization
  LEFT JOIN chain_roots AS root
    ON root.organization_id = organization.organization_id
  GROUP BY organization.organization_id
  HAVING count(root.event_hash) <> 1
),
leaf_anomalies AS (
  SELECT organization.organization_id
  FROM target_organizations AS organization
  LEFT JOIN public.audit_events AS leaf
    ON leaf.organization_id = organization.organization_id
   AND NOT EXISTS (
     SELECT 1
     FROM public.audit_events AS child
     WHERE child.organization_id = leaf.organization_id
       AND child.previous_event_hash = leaf.event_hash
   )
  GROUP BY organization.organization_id
  HAVING count(leaf.event_hash) <> 1
),
missing_predecessors AS (
  SELECT audit.id
  FROM public.audit_events AS audit
  WHERE audit.previous_event_hash IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.audit_events AS parent
      WHERE parent.organization_id = audit.organization_id
        AND parent.event_hash = audit.previous_event_hash
    )
),
forked_predecessors AS (
  SELECT child.organization_id, child.previous_event_hash
  FROM public.audit_events AS child
  WHERE child.previous_event_hash IS NOT NULL
  GROUP BY child.organization_id, child.previous_event_hash
  HAVING count(*) > 1
),
unreachable_events AS (
  SELECT audit.id
  FROM public.audit_events AS audit
  LEFT JOIN reachable_events AS reachable
    ON reachable.organization_id = audit.organization_id
   AND reachable.event_hash = audit.event_hash
  WHERE reachable.event_hash IS NULL
),
paired_events(action, topic, aggregate_type) AS (
  SELECT contract.audit_action, contract.outbox_topic, contract.aggregate_type
  FROM public.audit_outbox_pair_contract AS contract
  WHERE contract.contract_version = 'business-audit-outbox-v1'
),
paired_audit_counts AS (
  SELECT
    audit.organization_id,
    audit.request_id,
    pair.aggregate_type,
    audit.entity_id,
    pair.topic,
    count(*) FILTER (WHERE audit.entity_type = pair.aggregate_type)::bigint AS event_count
  FROM public.audit_events AS audit
  JOIN paired_events AS pair ON pair.action = audit.action
  GROUP BY audit.organization_id, audit.request_id, pair.aggregate_type, audit.entity_id, pair.topic
),
paired_outbox_counts AS (
  SELECT
    outbox.organization_id,
    outbox.request_id,
    outbox.aggregate_type,
    outbox.aggregate_id,
    outbox.topic,
    count(*)::bigint AS event_count
  FROM public.outbox_events AS outbox
  JOIN paired_events AS pair
    ON pair.topic = outbox.topic
   AND pair.aggregate_type = outbox.aggregate_type
  GROUP BY outbox.organization_id, outbox.request_id, outbox.aggregate_type, outbox.aggregate_id, outbox.topic
),
paired_count_mismatches AS (
  SELECT 1
  FROM paired_audit_counts AS audit
  FULL JOIN paired_outbox_counts AS outbox
    ON outbox.organization_id = audit.organization_id
   AND outbox.request_id = audit.request_id
   AND outbox.aggregate_type = audit.aggregate_type
   AND outbox.aggregate_id = audit.entity_id
   AND outbox.topic = audit.topic
  WHERE coalesce(audit.event_count, 0) <> coalesce(outbox.event_count, 0)
),
summary AS (
  SELECT
    (SELECT count(*) FROM target_organizations)::bigint AS organization_count,
    (SELECT count(*) FROM public.audit_events)::bigint AS audit_event_count,
    (SELECT count(*) FROM public.outbox_events)::bigint AS outbox_event_count,
    (SELECT count(*) FROM public.audit_events AS audit
      WHERE audit.event_hash !~ '^[0-9a-f]{64}$'
         OR (audit.previous_event_hash IS NOT NULL
           AND audit.previous_event_hash !~ '^[0-9a-f]{64}$'))::bigint AS invalid_hash_count,
    (SELECT count(*) FROM audit_hash_contract AS contract
      WHERE NOT contract.contract_valid)::bigint AS invalid_hash_contract_count,
    (SELECT count(*) FROM audit_hash_contract AS contract
      WHERE contract.contract_valid
        AND contract.event_hash IS DISTINCT FROM contract.expected_event_hash
    )::bigint AS hash_mismatch_count,
    (SELECT count(*) FROM public.audit_events AS audit
      WHERE length(audit.request_id) NOT BETWEEN 1 AND 200
         OR audit.request_id ~ E'[\\r\\n]')::bigint AS invalid_audit_request_count,
    (SELECT count(*) FROM public.outbox_events AS outbox
      WHERE length(outbox.request_id) NOT BETWEEN 1 AND 200
         OR outbox.request_id ~ E'[\\r\\n]'
         OR outbox.request_id LIKE 'legacy:%')::bigint AS invalid_outbox_request_count,
    (SELECT count(*) FROM root_anomalies)::bigint AS root_anomaly_count,
    (SELECT count(*) FROM leaf_anomalies)::bigint AS leaf_anomaly_count,
    (SELECT count(*) FROM missing_predecessors)::bigint AS missing_predecessor_count,
    (SELECT count(*) FROM forked_predecessors)::bigint AS forked_predecessor_count,
    (SELECT count(*) FROM unreachable_events)::bigint AS unreachable_event_count,
    (SELECT count(*)
      FROM public.outbox_events AS outbox
      LEFT JOIN paired_events AS pair
        ON pair.topic = outbox.topic
       AND pair.aggregate_type = outbox.aggregate_type
      WHERE pair.action IS NULL)::bigint AS invalid_outbox_contract_count,
    (SELECT count(*)
      FROM public.audit_events AS audit
      JOIN paired_events AS pair ON pair.action = audit.action
      WHERE audit.entity_type IS DISTINCT FROM pair.aggregate_type
        OR (
          SELECT count(*)
          FROM public.outbox_events AS outbox
          WHERE outbox.organization_id = audit.organization_id
            AND outbox.request_id = audit.request_id
            AND outbox.topic = pair.topic
            AND outbox.aggregate_type = pair.aggregate_type
            AND outbox.aggregate_id = audit.entity_id
        ) <> 1)::bigint AS audit_without_required_outbox_count,
    (SELECT count(*)
      FROM public.outbox_events AS outbox
      LEFT JOIN paired_events AS pair
        ON pair.topic = outbox.topic
       AND pair.aggregate_type = outbox.aggregate_type
      WHERE pair.action IS NULL
        OR (
          SELECT count(*)
          FROM public.audit_events AS audit
          WHERE audit.organization_id = outbox.organization_id
            AND audit.request_id = outbox.request_id
            AND audit.action = pair.action
            AND audit.entity_type = pair.aggregate_type
            AND audit.entity_id = outbox.aggregate_id
        ) <> 1)::bigint AS outbox_without_correct_audit_count,
    (SELECT count(*) FROM paired_count_mismatches)::bigint AS paired_count_mismatch_count
)
SELECT
  organization_count,
  audit_event_count,
  outbox_event_count,
  invalid_hash_count,
  invalid_hash_contract_count,
  hash_mismatch_count,
  invalid_audit_request_count,
  invalid_outbox_request_count,
  root_anomaly_count,
  leaf_anomaly_count,
  missing_predecessor_count,
  forked_predecessor_count,
  unreachable_event_count,
  invalid_outbox_contract_count,
  audit_without_required_outbox_count,
  outbox_without_correct_audit_count,
  paired_count_mismatch_count
FROM summary;
