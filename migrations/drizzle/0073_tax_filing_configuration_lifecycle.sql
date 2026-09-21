CREATE TABLE "tax_filing_canonical_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"registration_id" uuid,
	"filing_type_key" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"filing_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" text DEFAULT 'ACTIVE' NOT NULL,
	"supersedes_selection_id" uuid,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_filing_canonical_selections_version_check" CHECK ("tax_filing_canonical_selections"."version" > 0),
	CONSTRAINT "tax_filing_canonical_selections_state_check" CHECK ("tax_filing_canonical_selections"."state" IN ('ACTIVE', 'WITHDRAWN')),
	CONSTRAINT "tax_filing_canonical_selections_period_check" CHECK ("tax_filing_canonical_selections"."period_start" <= "tax_filing_canonical_selections"."period_end"),
	CONSTRAINT "tax_filing_canonical_selections_reason_check" CHECK (char_length(btrim("tax_filing_canonical_selections"."reason")) BETWEEN 8 AND 500),
	CONSTRAINT "tax_filing_canonical_selections_hash_check" CHECK ("tax_filing_canonical_selections"."command_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tax_filing_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"registration_id" uuid,
	"filing_type_key" text NOT NULL,
	"template_id" uuid NOT NULL,
	"mapping_set_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"supersedes_configuration_id" uuid,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_filing_configurations_version_check" CHECK ("tax_filing_configurations"."version" > 0),
	CONSTRAINT "tax_filing_configurations_state_check" CHECK ("tax_filing_configurations"."state" IN ('ACTIVE', 'INACTIVE', 'NEEDS_CONFIGURATION')),
	CONSTRAINT "tax_filing_configurations_effective_check" CHECK ("tax_filing_configurations"."effective_to" IS NULL OR "tax_filing_configurations"."effective_to" >= "tax_filing_configurations"."effective_from"),
	CONSTRAINT "tax_filing_configurations_reason_check" CHECK (char_length(btrim("tax_filing_configurations"."reason")) BETWEEN 8 AND 500),
	CONSTRAINT "tax_filing_configurations_hash_check" CHECK ("tax_filing_configurations"."command_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tax_filing_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"filing_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" text NOT NULL,
	"replacement_filing_id" uuid,
	"supersedes_event_id" uuid,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_filing_lifecycle_events_version_check" CHECK ("tax_filing_lifecycle_events"."version" > 0),
	CONSTRAINT "tax_filing_lifecycle_events_state_check" CHECK ("tax_filing_lifecycle_events"."state" IN ('CURRENT', 'HISTORICAL', 'SUPERSEDED', 'ARCHIVED')),
	CONSTRAINT "tax_filing_lifecycle_events_reason_check" CHECK (char_length(btrim("tax_filing_lifecycle_events"."reason")) BETWEEN 8 AND 500),
	CONSTRAINT "tax_filing_lifecycle_events_hash_check" CHECK ("tax_filing_lifecycle_events"."command_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "tax_filings" ADD COLUMN "configuration_id" uuid;--> statement-breakpoint
ALTER TABLE "tax_filings" ADD COLUMN "configuration_version" integer;--> statement-breakpoint
ALTER TABLE "tax_filing_canonical_selections" ADD CONSTRAINT "tax_filing_canonical_selections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_canonical_selections" ADD CONSTRAINT "tax_filing_canonical_selections_org_entity_fk" FOREIGN KEY ("organization_id","legal_entity_id") REFERENCES "public"."legal_entities"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_canonical_selections" ADD CONSTRAINT "tax_filing_canonical_selections_org_registration_fk" FOREIGN KEY ("organization_id","registration_id") REFERENCES "public"."entity_tax_registrations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_canonical_selections" ADD CONSTRAINT "tax_filing_canonical_selections_org_filing_fk" FOREIGN KEY ("organization_id","filing_id") REFERENCES "public"."tax_filings"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_canonical_selections" ADD CONSTRAINT "tax_filing_canonical_selections_org_supersedes_fk" FOREIGN KEY ("organization_id","supersedes_selection_id") REFERENCES "public"."tax_filing_canonical_selections"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_configurations" ADD CONSTRAINT "tax_filing_configurations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_configurations" ADD CONSTRAINT "tax_filing_configurations_template_id_tax_filing_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."tax_filing_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_configurations" ADD CONSTRAINT "tax_filing_configurations_org_entity_fk" FOREIGN KEY ("organization_id","legal_entity_id") REFERENCES "public"."legal_entities"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_configurations" ADD CONSTRAINT "tax_filing_configurations_org_ledger_fk" FOREIGN KEY ("organization_id","ledger_id") REFERENCES "public"."ledgers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_configurations" ADD CONSTRAINT "tax_filing_configurations_org_registration_fk" FOREIGN KEY ("organization_id","registration_id") REFERENCES "public"."entity_tax_registrations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_configurations" ADD CONSTRAINT "tax_filing_configurations_org_mapping_fk" FOREIGN KEY ("organization_id","mapping_set_id") REFERENCES "public"."tax_account_mapping_sets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_configurations" ADD CONSTRAINT "tax_filing_configurations_org_supersedes_fk" FOREIGN KEY ("organization_id","supersedes_configuration_id") REFERENCES "public"."tax_filing_configurations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_lifecycle_events" ADD CONSTRAINT "tax_filing_lifecycle_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_lifecycle_events" ADD CONSTRAINT "tax_filing_lifecycle_events_org_filing_fk" FOREIGN KEY ("organization_id","filing_id") REFERENCES "public"."tax_filings"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_lifecycle_events" ADD CONSTRAINT "tax_filing_lifecycle_events_org_replacement_fk" FOREIGN KEY ("organization_id","replacement_filing_id") REFERENCES "public"."tax_filings"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_lifecycle_events" ADD CONSTRAINT "tax_filing_lifecycle_events_org_supersedes_fk" FOREIGN KEY ("organization_id","supersedes_event_id") REFERENCES "public"."tax_filing_lifecycle_events"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_canonical_selections_org_id_unique" ON "tax_filing_canonical_selections" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_canonical_selections_org_idempotency_unique" ON "tax_filing_canonical_selections" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_canonical_selections_scope_version_unique" ON "tax_filing_canonical_selections" USING btree ("organization_id","legal_entity_id","registration_id","filing_type_key","period_start","period_end","version") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_canonical_selections_org_supersedes_unique" ON "tax_filing_canonical_selections" USING btree ("organization_id","supersedes_selection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_configurations_org_id_unique" ON "tax_filing_configurations" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_configurations_org_idempotency_unique" ON "tax_filing_configurations" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_configurations_scope_version_unique" ON "tax_filing_configurations" USING btree ("organization_id","legal_entity_id","registration_id","filing_type_key","version") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_configurations_org_supersedes_unique" ON "tax_filing_configurations" USING btree ("organization_id","supersedes_configuration_id");--> statement-breakpoint
CREATE INDEX "tax_filing_configurations_effective_lookup" ON "tax_filing_configurations" USING btree ("organization_id","legal_entity_id","filing_type_key","effective_from","effective_to");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_lifecycle_events_org_id_unique" ON "tax_filing_lifecycle_events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_lifecycle_events_filing_version_unique" ON "tax_filing_lifecycle_events" USING btree ("filing_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_lifecycle_events_org_idempotency_unique" ON "tax_filing_lifecycle_events" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_lifecycle_events_org_supersedes_unique" ON "tax_filing_lifecycle_events" USING btree ("organization_id","supersedes_event_id");--> statement-breakpoint
ALTER TABLE "tax_filings" ADD CONSTRAINT "tax_filings_org_configuration_fk" FOREIGN KEY ("organization_id","configuration_id") REFERENCES "public"."tax_filing_configurations"("organization_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

INSERT INTO tax_pack_versions(
  id,pack_key,version,jurisdiction,effective_from,effective_to,
  source_uri,source_digest,approved_by,approved_at
) VALUES (
  'a7100000-0000-4000-8000-000000000001'::uuid,
  'ca.atlantic.hst','2026.09.21','CA-ATLANTIC','2010-07-01',NULL,
  'https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html',
  'dbd19d071730e2ed88ed7364e12235ee83439cc5ac979e9764513b4a8cdaaa2c',
  '00000000-0000-4000-8000-000000000001'::uuid,'2026-09-21T00:00:00Z'::timestamptz
) ON CONFLICT (pack_key,version) DO NOTHING;

INSERT INTO permissions(key,description) VALUES
  ('tax.determinations.override','Preserve and authorize evidenced source-document tax overrides'),
  ('tax.filing.configuration.manage','Manage effective-dated tenant filing configuration versions'),
  ('tax.filing.canonical.manage','Select canonical filing workpapers and manage their lifecycle')
ON CONFLICT (key) DO UPDATE SET description=EXCLUDED.description;
--> statement-breakpoint

-- Backfill one configuration version for every existing mapping version. The
-- logical filing scope spans template versions, so versions and predecessor
-- links are derived across entity/registration/type rather than copied from a
-- mapping lineage. Only a single unambiguous current mapping becomes ACTIVE.
WITH candidates AS (
  SELECT mapping.*,template.template_key,
    CASE WHEN template.template_key='ca.gst-hst.return' AND registration.candidate_count=1
      THEN registration.id ELSE NULL END AS resolved_registration_id,
    coalesce(registration.candidate_count,0) AS registration_candidate_count,
    (mapping.state='ACTIVE' AND NOT EXISTS (
      SELECT 1 FROM tax_account_mapping_sets successor
      WHERE successor.organization_id=mapping.organization_id
        AND successor.supersedes_mapping_set_id=mapping.id
    )) AS current_active_mapping
  FROM tax_account_mapping_sets mapping
  JOIN tax_filing_templates template ON template.id=mapping.template_id
  LEFT JOIN LATERAL (
    SELECT (array_agg(candidate.id ORDER BY candidate.valid_from DESC,candidate.id))[1] AS id,
      count(*)::int AS candidate_count
    FROM entity_tax_registrations candidate
    WHERE candidate.organization_id=mapping.organization_id
      AND candidate.legal_entity_id=mapping.legal_entity_id
      AND candidate.valid_from <= mapping.effective_from
      AND (candidate.valid_to IS NULL OR candidate.valid_to >= coalesce(mapping.effective_to,mapping.effective_from))
      AND candidate.regime_key LIKE 'ca.%.hst'
  ) registration ON true
), ranked AS (
  SELECT candidates.*,
    row_number() OVER scope_order AS configuration_version,
    lag(id) OVER scope_order AS prior_configuration_id,
    count(*) FILTER (WHERE current_active_mapping) OVER scope_partition AS current_active_count,
    count(*) OVER scope_partition AS scope_count,
    row_number() OVER scope_latest AS latest_rank
  FROM candidates
  WINDOW
    scope_partition AS (PARTITION BY organization_id,legal_entity_id,resolved_registration_id,template_key),
    scope_order AS (PARTITION BY organization_id,legal_entity_id,resolved_registration_id,template_key
      ORDER BY effective_from,created_at,id),
    scope_latest AS (PARTITION BY organization_id,legal_entity_id,resolved_registration_id,template_key
      ORDER BY effective_from DESC,created_at DESC,id DESC)
)
INSERT INTO tax_filing_configurations(
  id,organization_id,legal_entity_id,ledger_id,registration_id,filing_type_key,
  template_id,mapping_set_id,version,state,effective_from,effective_to,
  supersedes_configuration_id,reason,idempotency_key,command_hash,created_by,created_at
)
SELECT ranked.id,ranked.organization_id,ranked.legal_entity_id,ranked.ledger_id,
  ranked.resolved_registration_id,ranked.template_key,ranked.template_id,ranked.id,
  ranked.configuration_version,
  CASE
    WHEN ranked.template_key='ca.gst-hst.return' AND ranked.registration_candidate_count<>1
      THEN CASE WHEN ranked.latest_rank=1 THEN 'NEEDS_CONFIGURATION' ELSE 'INACTIVE' END
    WHEN ranked.current_active_count=1 AND ranked.current_active_mapping THEN 'ACTIVE'
    WHEN ranked.current_active_count>1 AND ranked.latest_rank=1 THEN 'NEEDS_CONFIGURATION'
    ELSE 'INACTIVE'
  END,
  ranked.effective_from,ranked.effective_to,ranked.prior_configuration_id,
  'Backfilled from immutable mapping ' || ranked.id::text || ' (mapping version ' || ranked.version::text || ')',
  'migration:0073:configuration:' || ranked.id::text,
  encode(digest('migration:0073:configuration:' || ranked.id::text,'sha256'),'hex'),
  ranked.created_by,ranked.created_at
FROM ranked
ON CONFLICT (organization_id,id) DO NOTHING;

ALTER TABLE tax_filings DISABLE TRIGGER tax_filings_permission_guard;
UPDATE tax_filings filing SET
  configuration_id=filing.mapping_set_id,
  configuration_version=configuration.version
FROM tax_filing_configurations configuration
WHERE configuration.organization_id=filing.organization_id AND configuration.id=filing.mapping_set_id
  AND filing.configuration_id IS NULL;
ALTER TABLE tax_filings ENABLE TRIGGER tax_filings_permission_guard;

WITH ranked AS (
  SELECT filing.id,filing.organization_id,filing.filing_type,filing.created_by,filing.created_at,
    row_number() OVER (
      PARTITION BY filing.organization_id,filing.legal_entity_id,configuration.registration_id,
        configuration.filing_type_key,filing.period_start,filing.period_end,filing.filing_type
      ORDER BY filing.created_at DESC,filing.id DESC
    ) AS rank
  FROM tax_filings filing
  JOIN tax_filing_configurations configuration
    ON configuration.organization_id=filing.organization_id AND configuration.id=filing.configuration_id
)
INSERT INTO tax_filing_lifecycle_events(
  id,organization_id,filing_id,version,state,replacement_filing_id,
  supersedes_event_id,reason,idempotency_key,command_hash,created_by,created_at
)
SELECT ranked.id,ranked.organization_id,ranked.id,1,
  CASE WHEN ranked.filing_type='PREPARED' AND ranked.rank=1 THEN 'CURRENT' ELSE 'HISTORICAL' END,
  NULL,NULL,
  CASE WHEN ranked.filing_type='PREPARED' AND ranked.rank=1
    THEN 'Backfilled current prepared workpaper' ELSE 'Backfilled historical workpaper' END,
  'migration:0073:lifecycle:' || ranked.id::text,
  encode(digest('migration:0073:lifecycle:' || ranked.id::text,'sha256'),'hex'),
  ranked.created_by,ranked.created_at
FROM ranked
ON CONFLICT (organization_id,id) DO NOTHING;
--> statement-breakpoint

CREATE FUNCTION app.guard_tax_filing_configuration_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'business-finlynq:tax-filing-config:' || NEW.organization_id::text || ':' ||
    NEW.legal_entity_id::text || ':' || coalesce(NEW.registration_id::text,'none') || ':' || NEW.filing_type_key,0));
  IF NEW.state='ACTIVE' AND EXISTS (
    SELECT 1 FROM tax_filing_configurations existing
    WHERE existing.organization_id=NEW.organization_id
      AND existing.legal_entity_id=NEW.legal_entity_id
      AND existing.registration_id IS NOT DISTINCT FROM NEW.registration_id
      AND existing.filing_type_key=NEW.filing_type_key
      AND existing.state='ACTIVE'
      AND existing.id IS DISTINCT FROM NEW.supersedes_configuration_id
      AND daterange(existing.effective_from,coalesce(existing.effective_to,'infinity'::date),'[]')
        && daterange(NEW.effective_from,coalesce(NEW.effective_to,'infinity'::date),'[]')
      AND NOT EXISTS (SELECT 1 FROM tax_filing_configurations successor
        WHERE successor.organization_id=existing.organization_id
          AND successor.supersedes_configuration_id=existing.id)
  ) THEN
    RAISE EXCEPTION 'Overlapping active filing configuration' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_tax_filing_configuration_overlap() FROM PUBLIC;
CREATE TRIGGER tax_filing_configuration_overlap_guard
  BEFORE INSERT ON tax_filing_configurations
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_filing_configuration_overlap();
--> statement-breakpoint

CREATE FUNCTION app.guard_tax_filing_configuration_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM tax_filing_configurations configuration
    JOIN tax_filing_templates template ON template.id=configuration.template_id
    JOIN tax_account_mapping_sets mapping
      ON mapping.organization_id=configuration.organization_id
     AND mapping.id=configuration.mapping_set_id
    WHERE configuration.organization_id=NEW.organization_id
      AND configuration.id=NEW.configuration_id
      AND configuration.version=NEW.configuration_version
      AND configuration.legal_entity_id=NEW.legal_entity_id
      AND configuration.ledger_id=NEW.ledger_id
      AND configuration.template_id=NEW.template_id
      AND configuration.mapping_set_id=NEW.mapping_set_id
      AND configuration.state='ACTIVE'
      AND configuration.effective_from<=NEW.period_end
      AND (configuration.effective_to IS NULL OR configuration.effective_to>=NEW.period_end)
      AND NOT EXISTS (SELECT 1 FROM tax_filing_configurations successor
        WHERE successor.organization_id=configuration.organization_id
          AND successor.supersedes_configuration_id=configuration.id
          AND successor.effective_from<=NEW.period_end)
      AND (NEW.template_snapshot->>'configurationId')::uuid=configuration.id
      AND (NEW.template_snapshot->>'configurationVersion')::integer=configuration.version
      AND template.template_key=configuration.filing_type_key
      AND mapping.template_id=configuration.template_id
  ) THEN
    RAISE EXCEPTION 'Tax filing configuration snapshot or dependency is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_tax_filing_configuration_reference() FROM PUBLIC;
CREATE TRIGGER tax_filing_configuration_reference_guard
  BEFORE INSERT ON tax_filings
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_filing_configuration_reference();
--> statement-breakpoint

CREATE FUNCTION app.guard_tax_filing_governance_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME='tax_filing_configurations' THEN
    IF NOT EXISTS (
      SELECT 1 FROM legal_entities entity
      JOIN ledgers ledger ON ledger.organization_id=entity.organization_id
        AND ledger.legal_entity_id=entity.id AND ledger.id=NEW.ledger_id
      JOIN tax_filing_templates template ON template.id=NEW.template_id
        AND template.template_key=NEW.filing_type_key
        AND template.effective_from<=NEW.effective_from
        AND (template.effective_to IS NULL OR
          (NEW.effective_to IS NOT NULL AND template.effective_to>=NEW.effective_to))
      JOIN tax_account_mapping_sets mapping ON mapping.organization_id=entity.organization_id
        AND mapping.id=NEW.mapping_set_id AND mapping.legal_entity_id=entity.id
        AND mapping.ledger_id=ledger.id AND mapping.template_id=template.id
        AND mapping.state='ACTIVE' AND mapping.effective_from<=NEW.effective_from
        AND (mapping.effective_to IS NULL OR
          (NEW.effective_to IS NOT NULL AND mapping.effective_to>=NEW.effective_to))
      WHERE entity.organization_id=NEW.organization_id AND entity.id=NEW.legal_entity_id
        AND (NEW.registration_id IS NULL OR EXISTS (
          SELECT 1 FROM entity_tax_registrations registration
          WHERE registration.organization_id=NEW.organization_id
            AND registration.id=NEW.registration_id
            AND registration.legal_entity_id=NEW.legal_entity_id
            AND registration.valid_from<=NEW.effective_from
            AND (registration.valid_to IS NULL OR registration.valid_to>=coalesce(NEW.effective_to,NEW.effective_from))
        ))
        AND (NEW.filing_type_key<>'ca.gst-hst.return' OR NEW.registration_id IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'Tax filing configuration dependencies are invalid' USING ERRCODE='23514';
    END IF;
    IF NOT (
      (NEW.version=1 AND NEW.supersedes_configuration_id IS NULL)
      OR EXISTS (
        SELECT 1 FROM tax_filing_configurations prior
        WHERE prior.organization_id=NEW.organization_id
          AND prior.id=NEW.supersedes_configuration_id
          AND prior.legal_entity_id=NEW.legal_entity_id
          AND prior.registration_id IS NOT DISTINCT FROM NEW.registration_id
          AND prior.filing_type_key=NEW.filing_type_key
          AND prior.version+1=NEW.version
          AND prior.effective_from<=NEW.effective_from
          AND NOT (prior.state='ACTIVE' AND prior.effective_to IS NOT NULL
            AND NEW.state='ACTIVE' AND NEW.effective_from<=prior.effective_to)
      )
    ) THEN
      RAISE EXCEPTION 'Tax filing configuration revision lineage is invalid' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='tax_filing_lifecycle_events' THEN
    IF NOT (
      (NEW.version=1 AND NEW.supersedes_event_id IS NULL AND NEW.replacement_filing_id IS NULL
        AND EXISTS (
          SELECT 1 FROM tax_filings filing
          WHERE filing.organization_id=NEW.organization_id AND filing.id=NEW.filing_id
            AND ((filing.filing_type='PREPARED' AND NEW.state='CURRENT')
              OR (filing.filing_type='HISTORICAL_IMPORT' AND NEW.state='HISTORICAL'))
        ))
      OR (NEW.version>1 AND EXISTS (
        SELECT 1 FROM tax_filing_lifecycle_events prior
        WHERE prior.organization_id=NEW.organization_id AND prior.id=NEW.supersedes_event_id
          AND prior.filing_id=NEW.filing_id AND prior.version+1=NEW.version
      ))
    ) THEN
      RAISE EXCEPTION 'Tax filing lifecycle lineage is invalid' USING ERRCODE='23514';
    END IF;
    IF (NEW.state='SUPERSEDED') IS DISTINCT FROM (NEW.replacement_filing_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Superseded lifecycle requires exactly one replacement' USING ERRCODE='23514';
    END IF;
    IF NEW.replacement_filing_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM tax_filings original
      JOIN tax_filing_configurations original_configuration
        ON original_configuration.organization_id=original.organization_id
       AND original_configuration.id=original.configuration_id
      JOIN tax_filings replacement
        ON replacement.organization_id=original.organization_id
       AND replacement.id=NEW.replacement_filing_id
       AND replacement.legal_entity_id=original.legal_entity_id
       AND replacement.period_start=original.period_start
       AND replacement.period_end=original.period_end
      JOIN tax_filing_configurations replacement_configuration
        ON replacement_configuration.organization_id=replacement.organization_id
       AND replacement_configuration.id=replacement.configuration_id
       AND replacement_configuration.registration_id IS NOT DISTINCT FROM original_configuration.registration_id
       AND replacement_configuration.filing_type_key=original_configuration.filing_type_key
      JOIN tax_filing_lifecycle_events replacement_lifecycle
        ON replacement_lifecycle.organization_id=replacement.organization_id
       AND replacement_lifecycle.filing_id=replacement.id
       AND replacement_lifecycle.state NOT IN ('ARCHIVED','SUPERSEDED')
       AND NOT EXISTS (SELECT 1 FROM tax_filing_lifecycle_events successor
         WHERE successor.organization_id=replacement_lifecycle.organization_id
           AND successor.supersedes_event_id=replacement_lifecycle.id)
      WHERE original.organization_id=NEW.organization_id AND original.id=NEW.filing_id
    ) THEN
      RAISE EXCEPTION 'Tax filing replacement scope or lifecycle is invalid' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM tax_filings filing
      JOIN tax_filing_configurations configuration
        ON configuration.organization_id=filing.organization_id AND configuration.id=filing.configuration_id
      JOIN tax_filing_lifecycle_events lifecycle
        ON lifecycle.organization_id=filing.organization_id AND lifecycle.filing_id=filing.id
      WHERE filing.organization_id=NEW.organization_id AND filing.id=NEW.filing_id
        AND filing.legal_entity_id=NEW.legal_entity_id
        AND configuration.registration_id IS NOT DISTINCT FROM NEW.registration_id
        AND configuration.filing_type_key=NEW.filing_type_key
        AND filing.period_start=NEW.period_start AND filing.period_end=NEW.period_end
        AND lifecycle.state NOT IN ('ARCHIVED','SUPERSEDED')
        AND NOT EXISTS (SELECT 1 FROM tax_filing_lifecycle_events successor
          WHERE successor.organization_id=lifecycle.organization_id
            AND successor.supersedes_event_id=lifecycle.id)
    ) OR NOT (
      (NEW.version=1 AND NEW.supersedes_selection_id IS NULL)
      OR EXISTS (
        SELECT 1 FROM tax_filing_canonical_selections prior
        WHERE prior.organization_id=NEW.organization_id AND prior.id=NEW.supersedes_selection_id
          AND prior.legal_entity_id=NEW.legal_entity_id
          AND prior.registration_id IS NOT DISTINCT FROM NEW.registration_id
          AND prior.filing_type_key=NEW.filing_type_key
          AND prior.period_start=NEW.period_start AND prior.period_end=NEW.period_end
          AND prior.version+1=NEW.version
      )
    ) THEN
      RAISE EXCEPTION 'Tax filing canonical selection scope or lineage is invalid' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_tax_filing_governance_integrity() FROM PUBLIC;
CREATE TRIGGER tax_filing_configurations_integrity_guard
  BEFORE INSERT ON tax_filing_configurations
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_filing_governance_integrity();
CREATE TRIGGER tax_filing_lifecycle_events_integrity_guard
  BEFORE INSERT ON tax_filing_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_filing_governance_integrity();
CREATE TRIGGER tax_filing_canonical_selections_integrity_guard
  BEFORE INSERT ON tax_filing_canonical_selections
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_filing_governance_integrity();
--> statement-breakpoint

ALTER TABLE tax_filing_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_filing_configurations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_filing_configurations
  USING (organization_id=app.current_organization_id())
  WITH CHECK (organization_id=app.current_organization_id());
ALTER TABLE tax_filing_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_filing_lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_filing_lifecycle_events
  USING (organization_id=app.current_organization_id())
  WITH CHECK (organization_id=app.current_organization_id());
ALTER TABLE tax_filing_canonical_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_filing_canonical_selections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_filing_canonical_selections
  USING (organization_id=app.current_organization_id())
  WITH CHECK (organization_id=app.current_organization_id());
--> statement-breakpoint

CREATE FUNCTION app.guard_tax_filing_governance_append()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE required_permission text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION '% is append-only',TG_TABLE_NAME USING ERRCODE='55000'; END IF;
  required_permission := CASE TG_TABLE_NAME
    WHEN 'tax_filing_configurations' THEN 'tax.filing.configuration.manage'
    WHEN 'tax_filing_lifecycle_events' THEN
      CASE WHEN NEW.version=1 AND NEW.supersedes_event_id IS NULL
        THEN 'tax.filings.prepare' ELSE 'tax.filing.canonical.manage' END
    ELSE 'tax.filing.canonical.manage'
  END;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR app.current_actor_id() IS NULL
    OR NOT app.current_actor_has_permission(required_permission)
    OR NEW.created_by IS DISTINCT FROM app.current_actor_id() THEN
    RAISE EXCEPTION 'Tax filing governance permission or actor context is invalid' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_tax_filing_governance_append() FROM PUBLIC;
CREATE TRIGGER tax_filing_configurations_permission_guard
  BEFORE INSERT OR UPDATE OR DELETE ON tax_filing_configurations
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_filing_governance_append();
CREATE TRIGGER tax_filing_lifecycle_events_permission_guard
  BEFORE INSERT OR UPDATE OR DELETE ON tax_filing_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_filing_governance_append();
CREATE TRIGGER tax_filing_canonical_selections_permission_guard
  BEFORE INSERT OR UPDATE OR DELETE ON tax_filing_canonical_selections
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_filing_governance_append();
--> statement-breakpoint

CREATE FUNCTION app.audit_tax_filing_governance_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
BEGIN
  PERFORM app.append_tenant_business_audit(
    NEW.organization_id,
    CASE TG_TABLE_NAME
      WHEN 'tax_filing_configurations' THEN 'tax.filing.configuration-version-created'
      WHEN 'tax_filing_canonical_selections' THEN 'tax.filing.canonical-version-created'
      ELSE 'tax.filing.lifecycle-version-created'
    END,
    TG_TABLE_NAME,NEW.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'version',NEW.version,'state',NEW.state,'commandHash',NEW.command_hash,
      'filingId',to_jsonb(NEW)->>'filing_id','templateId',to_jsonb(NEW)->>'template_id',
      'mappingSetId',to_jsonb(NEW)->>'mapping_set_id'
    )),NULL
  );
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.audit_tax_filing_governance_event() FROM PUBLIC;
CREATE TRIGGER tax_filing_configurations_business_audit AFTER INSERT ON tax_filing_configurations FOR EACH ROW EXECUTE FUNCTION app.audit_tax_filing_governance_event();
CREATE TRIGGER tax_filing_lifecycle_events_business_audit AFTER INSERT ON tax_filing_lifecycle_events FOR EACH ROW EXECUTE FUNCTION app.audit_tax_filing_governance_event();
CREATE TRIGGER tax_filing_canonical_selections_business_audit AFTER INSERT ON tax_filing_canonical_selections FOR EACH ROW EXECUTE FUNCTION app.audit_tax_filing_governance_event();
--> statement-breakpoint

REVOKE ALL ON tax_filing_configurations,tax_filing_lifecycle_events,tax_filing_canonical_selections FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='business_finlynq_app') THEN
    GRANT SELECT,INSERT ON tax_filing_configurations,tax_filing_lifecycle_events,tax_filing_canonical_selections TO business_finlynq_app;
    REVOKE UPDATE,DELETE ON tax_filing_configurations,tax_filing_lifecycle_events,tax_filing_canonical_selections FROM business_finlynq_app;
  END IF;
END
$$;
--> statement-breakpoint

INSERT INTO demo_sandbox_reset_tables(table_name,purge_order)
SELECT reset_table.table_name,reset_state.maximum_order+reset_table.ordinal::integer
FROM (SELECT coalesce(max(purge_order),0) AS maximum_order FROM demo_sandbox_reset_tables) reset_state
CROSS JOIN unnest(ARRAY[
  'tax_filing_canonical_selections','tax_filing_lifecycle_events','tax_filing_configurations'
]::text[]) WITH ORDINALITY AS reset_table(table_name,ordinal)
ON CONFLICT (table_name) DO NOTHING;
