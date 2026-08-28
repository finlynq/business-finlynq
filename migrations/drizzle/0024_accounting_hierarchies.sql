-- Versioned presentation hierarchies for natural accounts and every optional
-- account dimension. Posting combinations remain unchanged; published trees
-- are immutable, effective-dated report metadata.

CREATE TABLE accounting_hierarchies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  ledger_id uuid REFERENCES ledgers(id) ON DELETE RESTRICT,
  dimension_key text NOT NULL CHECK (dimension_key IN (
    'entity', 'account', 'subaccount', 'department', 'intercompany',
    'custom1', 'custom2', 'custom3', 'custom4',
    'custom5', 'custom6', 'custom7', 'custom8'
  )),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 160),
  version integer NOT NULL CHECK (version > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED')),
  based_on_hierarchy_id uuid,
  effective_from date,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  published_by uuid,
  published_at timestamp with time zone,
  CONSTRAINT accounting_hierarchies_dimension_scope_check CHECK (
    (dimension_key = 'account' AND ledger_id IS NOT NULL)
    OR (dimension_key <> 'account' AND ledger_id IS NULL)
  ),
  CONSTRAINT accounting_hierarchies_publication_check CHECK (
    (status = 'DRAFT' AND effective_from IS NULL AND published_by IS NULL AND published_at IS NULL)
    OR (status = 'PUBLISHED' AND effective_from IS NOT NULL AND published_by IS NOT NULL AND published_at IS NOT NULL)
  ),
  CONSTRAINT accounting_hierarchies_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT accounting_hierarchies_org_ledger_id_unique UNIQUE (organization_id, ledger_id, id),
  CONSTRAINT accounting_hierarchies_based_on_fk FOREIGN KEY (organization_id, based_on_hierarchy_id)
    REFERENCES accounting_hierarchies(organization_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX accounting_hierarchies_family_version_unique
  ON accounting_hierarchies(
    organization_id,
    coalesce(ledger_id, '00000000-0000-0000-0000-000000000000'::uuid),
    dimension_key, code, version
  );
CREATE UNIQUE INDEX accounting_hierarchies_one_draft_per_family
  ON accounting_hierarchies(
    organization_id,
    coalesce(ledger_id, '00000000-0000-0000-0000-000000000000'::uuid),
    dimension_key, code
  ) WHERE status = 'DRAFT';
CREATE INDEX accounting_hierarchies_published_lookup
  ON accounting_hierarchies(organization_id, ledger_id, dimension_key, code, effective_from DESC)
  WHERE status = 'PUBLISHED';
--> statement-breakpoint

CREATE TABLE accounting_hierarchy_nodes (
  id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  hierarchy_id uuid NOT NULL,
  parent_id uuid,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 160),
  sort_order integer NOT NULL CHECK (sort_order BETWEEN 0 AND 1000000),
  statement_class text CHECK (statement_class IS NULL OR statement_class IN (
    'ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'
  )),
  member_type text CHECK (member_type IS NULL OR member_type IN ('ACCOUNT', 'SEGMENT_VALUE', 'ENTITY')),
  gl_account_id uuid,
  segment_value_id uuid,
  legal_entity_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT accounting_hierarchy_nodes_pk PRIMARY KEY (id),
  CONSTRAINT accounting_hierarchy_nodes_org_hierarchy_id_unique UNIQUE (organization_id, hierarchy_id, id),
  CONSTRAINT accounting_hierarchy_nodes_hierarchy_fk FOREIGN KEY (organization_id, hierarchy_id)
    REFERENCES accounting_hierarchies(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT accounting_hierarchy_nodes_parent_fk FOREIGN KEY (organization_id, hierarchy_id, parent_id)
    REFERENCES accounting_hierarchy_nodes(organization_id, hierarchy_id, id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT accounting_hierarchy_nodes_account_fk FOREIGN KEY (organization_id, gl_account_id)
    REFERENCES gl_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_hierarchy_nodes_segment_value_fk FOREIGN KEY (organization_id, segment_value_id)
    REFERENCES segment_values(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_hierarchy_nodes_entity_fk FOREIGN KEY (organization_id, legal_entity_id)
    REFERENCES legal_entities(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_hierarchy_nodes_member_check CHECK (
    (member_type IS NULL AND num_nonnulls(gl_account_id, segment_value_id, legal_entity_id) = 0)
    OR (member_type = 'ACCOUNT' AND gl_account_id IS NOT NULL
      AND segment_value_id IS NULL AND legal_entity_id IS NULL)
    OR (member_type = 'SEGMENT_VALUE' AND segment_value_id IS NOT NULL
      AND gl_account_id IS NULL AND legal_entity_id IS NULL)
    OR (member_type = 'ENTITY' AND legal_entity_id IS NOT NULL
      AND gl_account_id IS NULL AND segment_value_id IS NULL)
  ),
  CONSTRAINT accounting_hierarchy_nodes_member_statement_check CHECK (
    member_type IS NULL OR statement_class IS NULL
  ),
  CONSTRAINT accounting_hierarchy_nodes_not_self_parent_check CHECK (parent_id IS DISTINCT FROM id),
  CONSTRAINT accounting_hierarchy_nodes_code_unique UNIQUE (hierarchy_id, code)
);

CREATE UNIQUE INDEX accounting_hierarchy_nodes_account_member_unique
  ON accounting_hierarchy_nodes(hierarchy_id, gl_account_id)
  WHERE gl_account_id IS NOT NULL;
CREATE UNIQUE INDEX accounting_hierarchy_nodes_segment_member_unique
  ON accounting_hierarchy_nodes(hierarchy_id, segment_value_id)
  WHERE segment_value_id IS NOT NULL;
CREATE UNIQUE INDEX accounting_hierarchy_nodes_entity_member_unique
  ON accounting_hierarchy_nodes(hierarchy_id, legal_entity_id)
  WHERE legal_entity_id IS NOT NULL;
CREATE INDEX accounting_hierarchy_nodes_tree_order
  ON accounting_hierarchy_nodes(hierarchy_id, parent_id, sort_order, code, id);
--> statement-breakpoint

ALTER TABLE accounting_hierarchies ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_hierarchies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounting_hierarchies
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
ALTER TABLE accounting_hierarchy_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_hierarchy_nodes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounting_hierarchy_nodes
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.accounting_hierarchy_header_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'Published accounting hierarchies are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION app.accounting_hierarchy_header_guard() FROM PUBLIC;
CREATE TRIGGER accounting_hierarchies_immutable
  BEFORE UPDATE OR DELETE ON accounting_hierarchies
  FOR EACH ROW EXECUTE FUNCTION app.accounting_hierarchy_header_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.accounting_hierarchy_node_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_hierarchy accounting_hierarchies%ROWTYPE;
  selected_definition_key text;
  selected_organization_id uuid;
  selected_hierarchy_id uuid;
BEGIN
  selected_organization_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  selected_hierarchy_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.hierarchy_id ELSE NEW.hierarchy_id END;
  SELECT hierarchy.* INTO selected_hierarchy
  FROM accounting_hierarchies hierarchy
  WHERE hierarchy.organization_id = selected_organization_id
    AND hierarchy.id = selected_hierarchy_id
  FOR SHARE;
  IF selected_hierarchy.id IS NULL OR selected_hierarchy.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Only draft hierarchy nodes can be changed' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

  IF NEW.member_type IS NULL THEN
    IF selected_hierarchy.dimension_key <> 'account' AND NEW.statement_class IS NOT NULL THEN
      RAISE EXCEPTION 'Only natural-account groups can define a statement class' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.member_type = 'ACCOUNT' THEN
    IF selected_hierarchy.dimension_key <> 'account' OR NOT EXISTS (
      SELECT 1 FROM gl_accounts account
      WHERE account.organization_id = NEW.organization_id
        AND account.id = NEW.gl_account_id
        AND account.ledger_id = selected_hierarchy.ledger_id
        AND account.active
        AND account.postable
    ) THEN
      RAISE EXCEPTION 'Hierarchy account member is outside the selected active ledger' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.member_type = 'SEGMENT_VALUE' THEN
    SELECT lower(definition.key) INTO selected_definition_key
    FROM segment_values value
    JOIN segment_definitions definition
      ON definition.organization_id = value.organization_id
     AND definition.id = value.definition_id
    WHERE value.organization_id = NEW.organization_id
      AND value.id = NEW.segment_value_id
      AND value.active;
    IF selected_hierarchy.dimension_key IN ('entity', 'account', 'intercompany')
      OR selected_definition_key IS DISTINCT FROM selected_hierarchy.dimension_key THEN
      RAISE EXCEPTION 'Hierarchy segment member belongs to another dimension' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.member_type = 'ENTITY' THEN
    IF selected_hierarchy.dimension_key NOT IN ('entity', 'intercompany') OR NOT EXISTS (
      SELECT 1 FROM legal_entities entity
      WHERE entity.organization_id = NEW.organization_id
        AND entity.id = NEW.legal_entity_id AND entity.active
    ) THEN
      RAISE EXCEPTION 'Hierarchy entity member is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.accounting_hierarchy_node_guard() FROM PUBLIC;
CREATE TRIGGER accounting_hierarchy_nodes_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON accounting_hierarchy_nodes
  FOR EACH ROW EXECUTE FUNCTION app.accounting_hierarchy_node_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.accounting_create_hierarchy_draft(
  selected_dimension_key text,
  selected_ledger_id uuid,
  selected_code text,
  selected_display_name text,
  selected_based_on_hierarchy_id uuid
)
RETURNS TABLE(id uuid, version integer, revision integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  admin_context record;
  selected_organization_id uuid;
  normalized_dimension text := lower(trim(selected_dimension_key));
  normalized_code text := upper(trim(selected_code));
  based_on accounting_hierarchies%ROWTYPE;
  created accounting_hierarchies%ROWTYPE;
BEGIN
  SELECT * INTO admin_context
  FROM app.organization_admin_authorize('ledger.segments.manage', false);
  selected_organization_id := admin_context.organization_id;
  IF normalized_dimension NOT IN (
      'entity', 'account', 'subaccount', 'department', 'intercompany',
      'custom1', 'custom2', 'custom3', 'custom4',
      'custom5', 'custom6', 'custom7', 'custom8'
    ) OR normalized_code !~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'
    OR length(trim(selected_display_name)) NOT BETWEEN 2 AND 160
    OR (normalized_dimension = 'account') <> (selected_ledger_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid accounting hierarchy draft' USING ERRCODE = '22023';
  END IF;
  IF normalized_dimension = 'account' AND NOT EXISTS (
    SELECT 1 FROM ledgers ledger
    WHERE ledger.organization_id = selected_organization_id
      AND ledger.id = selected_ledger_id AND ledger.active
  ) THEN
    RAISE EXCEPTION 'Hierarchy ledger is unavailable' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|accounting-hierarchy|' || normalized_dimension || '|' ||
      coalesce(selected_ledger_id::text, 'organization') || '|' || normalized_code, 0
  ));
  IF selected_based_on_hierarchy_id IS NOT NULL THEN
    SELECT hierarchy.* INTO based_on
    FROM accounting_hierarchies hierarchy
    WHERE hierarchy.organization_id = selected_organization_id
      AND hierarchy.id = selected_based_on_hierarchy_id
      AND hierarchy.status = 'PUBLISHED';
    IF based_on.id IS NULL OR based_on.dimension_key <> normalized_dimension
      OR based_on.code <> normalized_code
      OR based_on.ledger_id IS DISTINCT FROM selected_ledger_id THEN
      RAISE EXCEPTION 'The published hierarchy cannot be used as this draft base' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO accounting_hierarchies(
    organization_id, ledger_id, dimension_key, code, display_name,
    version, revision, status, based_on_hierarchy_id, created_by
  ) VALUES (
    selected_organization_id, selected_ledger_id, normalized_dimension,
    normalized_code, trim(selected_display_name),
    coalesce((SELECT max(hierarchy.version) + 1
      FROM accounting_hierarchies hierarchy
      WHERE hierarchy.organization_id = selected_organization_id
        AND hierarchy.ledger_id IS NOT DISTINCT FROM selected_ledger_id
        AND hierarchy.dimension_key = normalized_dimension
        AND hierarchy.code = normalized_code), 1),
    1, 'DRAFT', selected_based_on_hierarchy_id, admin_context.actor_id
  ) RETURNING * INTO created;

  PERFORM app.append_tenant_business_audit(
    selected_organization_id,
    'accounting.hierarchy.draft_created',
    'accounting_hierarchy',
    created.id::text,
    jsonb_build_object(
      'dimensionKey', created.dimension_key,
      'ledgerId', created.ledger_id,
      'code', created.code,
      'version', created.version,
      'basedOnHierarchyId', created.based_on_hierarchy_id
    ),
    NULL
  );
  id := created.id;
  version := created.version;
  revision := created.revision;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION app.accounting_create_hierarchy_draft(text, uuid, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.accounting_replace_hierarchy_draft(
  selected_hierarchy_id uuid,
  selected_expected_revision integer,
  selected_nodes jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  admin_context record;
  selected_organization_id uuid;
  selected_hierarchy accounting_hierarchies%ROWTYPE;
  next_revision integer;
BEGIN
  SELECT * INTO admin_context
  FROM app.organization_admin_authorize('ledger.segments.manage', false);
  selected_organization_id := admin_context.organization_id;
  IF selected_hierarchy_id IS NULL OR selected_expected_revision IS NULL
    OR selected_expected_revision < 1
    OR jsonb_typeof(selected_nodes) IS DISTINCT FROM 'array'
    OR jsonb_array_length(selected_nodes) > 5000 THEN
    RAISE EXCEPTION 'Invalid accounting hierarchy tree' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|accounting-hierarchy-draft|' || selected_hierarchy_id::text, 0
  ));
  SELECT hierarchy.* INTO selected_hierarchy
  FROM accounting_hierarchies hierarchy
  WHERE hierarchy.organization_id = selected_organization_id
    AND hierarchy.id = selected_hierarchy_id
  FOR UPDATE;
  IF selected_hierarchy.id IS NULL OR selected_hierarchy.status <> 'DRAFT'
    OR selected_hierarchy.revision <> selected_expected_revision THEN
    RAISE EXCEPTION 'Hierarchy draft changed or is no longer editable' USING ERRCODE = '40001';
  END IF;

  DELETE FROM accounting_hierarchy_nodes node
  WHERE node.organization_id = selected_organization_id
    AND node.hierarchy_id = selected_hierarchy_id;
  INSERT INTO accounting_hierarchy_nodes(
    id, organization_id, hierarchy_id, parent_id, code, display_name,
    sort_order, statement_class, member_type,
    gl_account_id, segment_value_id, legal_entity_id
  )
  SELECT
    (item.value ->> 'id')::uuid,
    selected_organization_id,
    selected_hierarchy_id,
    nullif(item.value ->> 'parentId', '')::uuid,
    upper(trim(item.value ->> 'code')),
    trim(item.value ->> 'displayName'),
    (item.value ->> 'sortOrder')::integer,
    nullif(item.value ->> 'statementClass', ''),
    nullif(item.value ->> 'memberType', ''),
    nullif(item.value ->> 'glAccountId', '')::uuid,
    nullif(item.value ->> 'segmentValueId', '')::uuid,
    nullif(item.value ->> 'legalEntityId', '')::uuid
  FROM jsonb_array_elements(selected_nodes) WITH ORDINALITY item(value, ordinal);

  IF EXISTS (
    SELECT 1
    FROM accounting_hierarchy_nodes child
    JOIN accounting_hierarchy_nodes parent
      ON parent.organization_id = child.organization_id
     AND parent.hierarchy_id = child.hierarchy_id
     AND parent.id = child.parent_id
    WHERE child.organization_id = selected_organization_id
      AND child.hierarchy_id = selected_hierarchy_id
      AND parent.member_type IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Hierarchy members cannot contain child nodes' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestry AS (
      SELECT node.id AS start_id, node.id, node.parent_id,
        ARRAY[node.id]::uuid[] AS path, false AS cycle
      FROM accounting_hierarchy_nodes node
      WHERE node.organization_id = selected_organization_id
        AND node.hierarchy_id = selected_hierarchy_id
      UNION ALL
      SELECT ancestry.start_id, parent.id, parent.parent_id,
        ancestry.path || parent.id, parent.id = ANY(ancestry.path)
      FROM ancestry
      JOIN accounting_hierarchy_nodes parent
        ON parent.organization_id = selected_organization_id
       AND parent.hierarchy_id = selected_hierarchy_id
       AND parent.id = ancestry.parent_id
      WHERE NOT ancestry.cycle
    )
    SELECT 1 FROM ancestry WHERE cycle
  ) THEN
    RAISE EXCEPTION 'Accounting hierarchy contains a cycle' USING ERRCODE = '23514';
  END IF;

  UPDATE accounting_hierarchies hierarchy SET revision = hierarchy.revision + 1
  WHERE hierarchy.organization_id = selected_organization_id
    AND hierarchy.id = selected_hierarchy_id
    AND hierarchy.revision = selected_expected_revision
  RETURNING hierarchy.revision INTO next_revision;
  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'Hierarchy draft changed while it was being saved' USING ERRCODE = '40001';
  END IF;
  PERFORM app.append_tenant_business_audit(
    selected_organization_id,
    'accounting.hierarchy.draft_saved',
    'accounting_hierarchy',
    selected_hierarchy_id::text,
    jsonb_build_object(
      'revision', next_revision,
      'nodeCount', jsonb_array_length(selected_nodes)
    ),
    NULL
  );
  RETURN next_revision;
END
$$;
REVOKE ALL ON FUNCTION app.accounting_replace_hierarchy_draft(uuid, integer, jsonb) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.accounting_publish_hierarchy(
  selected_hierarchy_id uuid,
  selected_expected_revision integer,
  selected_effective_from date
)
RETURNS TABLE(version integer, effective_from date)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  admin_context record;
  selected_organization_id uuid;
  selected_hierarchy accounting_hierarchies%ROWTYPE;
BEGIN
  SELECT * INTO admin_context
  FROM app.organization_admin_authorize('ledger.segments.manage', true);
  selected_organization_id := admin_context.organization_id;
  IF selected_hierarchy_id IS NULL OR selected_expected_revision IS NULL
    OR selected_expected_revision < 1 OR selected_effective_from IS NULL THEN
    RAISE EXCEPTION 'Invalid accounting hierarchy publication' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|accounting-hierarchy-publish|' || selected_hierarchy_id::text, 0
  ));
  SELECT hierarchy.* INTO selected_hierarchy
  FROM accounting_hierarchies hierarchy
  WHERE hierarchy.organization_id = selected_organization_id
    AND hierarchy.id = selected_hierarchy_id
  FOR UPDATE;
  IF selected_hierarchy.id IS NULL OR selected_hierarchy.status <> 'DRAFT'
    OR selected_hierarchy.revision <> selected_expected_revision THEN
    RAISE EXCEPTION 'Hierarchy draft changed or is no longer publishable' USING ERRCODE = '40001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM accounting_hierarchy_nodes node
    WHERE node.organization_id = selected_organization_id
      AND node.hierarchy_id = selected_hierarchy_id
  ) THEN
    RAISE EXCEPTION 'A hierarchy needs at least one group before publication' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM accounting_hierarchy_nodes node
    WHERE node.organization_id = selected_organization_id
      AND node.hierarchy_id = selected_hierarchy_id
      AND node.member_type IS NULL
  ) OR EXISTS (
    SELECT 1 FROM accounting_hierarchy_nodes member
    WHERE member.organization_id = selected_organization_id
      AND member.hierarchy_id = selected_hierarchy_id
      AND member.member_type IS NOT NULL
      AND member.parent_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Published hierarchy members must be assigned below a group' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM accounting_hierarchies published
    WHERE published.organization_id = selected_organization_id
      AND published.ledger_id IS NOT DISTINCT FROM selected_hierarchy.ledger_id
      AND published.dimension_key = selected_hierarchy.dimension_key
      AND published.code = selected_hierarchy.code
      AND published.status = 'PUBLISHED'
      AND published.effective_from >= selected_effective_from
  ) THEN
    RAISE EXCEPTION 'A new hierarchy version must start after its latest published version' USING ERRCODE = '55000';
  END IF;

  IF selected_hierarchy.dimension_key = 'account' THEN
    IF EXISTS (
      SELECT 1 FROM accounting_hierarchy_nodes root
      WHERE root.organization_id = selected_organization_id
        AND root.hierarchy_id = selected_hierarchy_id
        AND root.parent_id IS NULL
        AND (root.member_type IS NOT NULL OR root.statement_class IS NULL)
    ) OR EXISTS (
      SELECT 1 FROM gl_accounts account
      WHERE account.organization_id = selected_organization_id
        AND account.ledger_id = selected_hierarchy.ledger_id
        AND account.active
        AND account.postable
        AND NOT EXISTS (
          SELECT 1 FROM accounting_hierarchy_nodes member
          WHERE member.organization_id = account.organization_id
            AND member.hierarchy_id = selected_hierarchy_id
            AND member.gl_account_id = account.id
        )
    ) OR EXISTS (
      WITH RECURSIVE tree AS (
        SELECT root.id, root.statement_class AS root_class
        FROM accounting_hierarchy_nodes root
        WHERE root.organization_id = selected_organization_id
          AND root.hierarchy_id = selected_hierarchy_id
          AND root.parent_id IS NULL
        UNION ALL
        SELECT child.id, tree.root_class
        FROM tree
        JOIN accounting_hierarchy_nodes child
          ON child.organization_id = selected_organization_id
         AND child.hierarchy_id = selected_hierarchy_id
         AND child.parent_id = tree.id
      )
      SELECT 1
      FROM tree
      JOIN accounting_hierarchy_nodes node ON node.id = tree.id
      LEFT JOIN gl_accounts account ON account.id = node.gl_account_id
      WHERE (node.statement_class IS NOT NULL AND node.statement_class <> tree.root_class)
         OR (node.gl_account_id IS NOT NULL AND account.class::text <> tree.root_class)
    ) THEN
      RAISE EXCEPTION 'Every active account must appear under the matching statement-class root' USING ERRCODE = '23514';
    END IF;
  ELSIF selected_hierarchy.dimension_key IN ('entity', 'intercompany') THEN
    IF EXISTS (
      SELECT 1 FROM legal_entities entity
      WHERE entity.organization_id = selected_organization_id AND entity.active
        AND NOT EXISTS (
          SELECT 1 FROM accounting_hierarchy_nodes member
          WHERE member.organization_id = entity.organization_id
            AND member.hierarchy_id = selected_hierarchy_id
            AND member.legal_entity_id = entity.id
        )
    ) THEN
      RAISE EXCEPTION 'Every active legal entity must appear in the entity hierarchy' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM segment_definitions definition
      WHERE definition.organization_id = selected_organization_id
        AND lower(definition.key) = selected_hierarchy.dimension_key
        AND definition.state <> 'EMPTY'
    ) OR EXISTS (
      SELECT 1
      FROM segment_values value
      JOIN segment_definitions definition
        ON definition.organization_id = value.organization_id
       AND definition.id = value.definition_id
      WHERE value.organization_id = selected_organization_id
        AND lower(definition.key) = selected_hierarchy.dimension_key
        AND value.active
        AND NOT EXISTS (
          SELECT 1 FROM accounting_hierarchy_nodes member
          WHERE member.organization_id = value.organization_id
            AND member.hierarchy_id = selected_hierarchy_id
            AND member.segment_value_id = value.id
        )
    ) THEN
      RAISE EXCEPTION 'Configure the segment and assign every active value before publication' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE accounting_hierarchies hierarchy SET
    status = 'PUBLISHED',
    effective_from = selected_effective_from,
    published_by = admin_context.actor_id,
    published_at = now(),
    revision = hierarchy.revision + 1
  WHERE hierarchy.organization_id = selected_organization_id
    AND hierarchy.id = selected_hierarchy_id
    AND hierarchy.status = 'DRAFT'
    AND hierarchy.revision = selected_expected_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hierarchy draft changed while it was being published'
      USING ERRCODE = '40001';
  END IF;
  PERFORM app.append_tenant_business_audit(
    selected_organization_id,
    'accounting.hierarchy.published',
    'accounting_hierarchy',
    selected_hierarchy_id::text,
    jsonb_build_object(
      'dimensionKey', selected_hierarchy.dimension_key,
      'ledgerId', selected_hierarchy.ledger_id,
      'code', selected_hierarchy.code,
      'version', selected_hierarchy.version,
      'effectiveFrom', selected_effective_from
    ),
    NULL
  );
  version := selected_hierarchy.version;
  effective_from := selected_effective_from;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION app.accounting_publish_hierarchy(uuid, integer, date) FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON accounting_hierarchies, accounting_hierarchy_nodes FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT SELECT ON accounting_hierarchies, accounting_hierarchy_nodes TO business_finlynq_app;
    GRANT EXECUTE ON FUNCTION
      app.accounting_create_hierarchy_draft(text, uuid, text, text, uuid),
      app.accounting_replace_hierarchy_draft(uuid, integer, jsonb),
      app.accounting_publish_hierarchy(uuid, integer, date)
    TO business_finlynq_app;
  END IF;
END
$$;
--> statement-breakpoint

INSERT INTO demo_sandbox_reset_tables(table_name, purge_order) VALUES
  ('accounting_hierarchy_nodes', 44),
  ('accounting_hierarchies', 45)
ON CONFLICT (table_name) DO UPDATE SET purge_order = EXCLUDED.purge_order;
