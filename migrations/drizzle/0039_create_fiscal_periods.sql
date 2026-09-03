-- Add an explicit, high-assurance capability for extending an existing ledger's
-- calendar. The application role keeps no direct INSERT privilege on periods;
-- all creation goes through the tenant-authorized function below.

INSERT INTO permissions(key, description) VALUES (
  'ledger.period.create',
  'Create non-overlapping fiscal periods for an existing ledger'
)
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;
--> statement-breakpoint

INSERT INTO role_permissions(organization_id, role_id, permission_key)
SELECT role.organization_id, role.id, 'ledger.period.create'
FROM roles role
WHERE
  (role.system_template AND role.key IN ('OWNER', 'ACCOUNTANT_APPROVER'))
  OR role.key = 'demo_accountant'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.assign_fiscal_period_template_permission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT (
    (NEW.system_template AND NEW.key IN ('OWNER', 'ACCOUNTANT_APPROVER'))
    OR NEW.key = 'demo_accountant'
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.role_permissions(organization_id, role_id, permission_key)
  SELECT NEW.organization_id, NEW.id, permission.key
  FROM public.permissions permission
  WHERE permission.key = 'ledger.period.create'
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.assign_fiscal_period_template_permission() FROM PUBLIC;
DROP TRIGGER IF EXISTS assign_fiscal_period_template_permission ON roles;
CREATE CONSTRAINT TRIGGER assign_fiscal_period_template_permission
  AFTER INSERT OR UPDATE OF key, system_template ON roles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assign_fiscal_period_template_permission();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.accounting_create_fiscal_periods(
  selected_ledger_id uuid,
  selected_fiscal_year integer,
  selected_period_pattern text,
  selected_initial_state period_state,
  selected_command_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  admin_context record;
  selected_organization_id uuid;
  request_key text;
  prior_audit jsonb;
  created_period_ids uuid[] := ARRAY[]::uuid[];
  conflict_count integer := 0;
  response jsonb;
BEGIN
  SELECT * INTO admin_context
  FROM app.organization_admin_authorize('ledger.period.create', true);
  selected_organization_id := admin_context.organization_id;
  request_key := nullif(current_setting('app.request_id', true), '');

  IF selected_ledger_id IS NULL
    OR selected_fiscal_year IS NULL
    OR selected_fiscal_year NOT BETWEEN 2000 AND 2200
    OR selected_period_pattern IS DISTINCT FROM 'MONTHLY'
    OR selected_initial_state IS DISTINCT FROM 'OPEN'::period_state
    OR selected_command_hash IS NULL
    OR selected_command_hash !~ '^[0-9a-f]{64}$'
    OR request_key IS NULL
    OR char_length(trim(coalesce(current_setting('app.reason', true), ''))) < 8 THEN
    RAISE EXCEPTION 'Invalid fiscal-period creation command'
      USING ERRCODE = '22023';
  END IF;

  -- The request lock makes one idempotency key authoritative across all ledgers
  -- in the organization. The calendar lock serializes different request keys
  -- that target the same ledger.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|fiscal-period-request|' || request_key,
    0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    selected_organization_id::text || '|ledger-calendar|' || selected_ledger_id::text,
    0
  ));

  SELECT audit.safe_metadata INTO prior_audit
  FROM public.audit_events audit
  WHERE audit.organization_id = selected_organization_id
    AND audit.request_id = request_key
    AND audit.action = 'ledger.fiscal_periods.provisioned'
  ORDER BY audit.occurred_at, audit.id
  LIMIT 1;

  IF prior_audit IS NOT NULL THEN
    IF prior_audit->>'commandHash' IS DISTINCT FROM selected_command_hash THEN
      RAISE EXCEPTION 'Idempotency key was already used for a different fiscal-period command'
        USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_set(
      prior_audit->'result',
      '{idempotentReplay}',
      'true'::jsonb,
      false
    );
  END IF;

  PERFORM 1
  FROM public.ledgers ledger
  INNER JOIN public.legal_entities entity
    ON entity.organization_id = ledger.organization_id
   AND entity.id = ledger.legal_entity_id
  WHERE ledger.organization_id = selected_organization_id
    AND ledger.id = selected_ledger_id
    AND ledger.active
    AND entity.active
  FOR SHARE OF ledger, entity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'An active ledger and legal entity are required'
      USING ERRCODE = '22023';
  END IF;

  WITH expected AS (
    SELECT
      month_number AS period_number,
      make_date(selected_fiscal_year, month_number, 1) AS starts_on,
      (make_date(selected_fiscal_year, month_number, 1)
        + interval '1 month - 1 day')::date AS ends_on
    FROM generate_series(1, 12) AS month_number
  )
  SELECT count(*)::integer INTO conflict_count
  FROM public.fiscal_periods period
  WHERE period.organization_id = selected_organization_id
    AND period.ledger_id = selected_ledger_id
    AND (
      (
        period.fiscal_year = selected_fiscal_year
        AND NOT EXISTS (
          SELECT 1
          FROM expected
          WHERE expected.period_number = period.period_number
            AND expected.starts_on = period.starts_on
            AND expected.ends_on = period.ends_on
        )
      )
      OR (
        period.fiscal_year <> selected_fiscal_year
        AND daterange(period.starts_on, period.ends_on, '[]')
          && daterange(
            make_date(selected_fiscal_year, 1, 1),
            make_date(selected_fiscal_year, 12, 31),
            '[]'
          )
      )
    );

  IF conflict_count > 0 THEN
    WITH expected AS (
      SELECT
        month_number AS period_number,
        make_date(selected_fiscal_year, month_number, 1) AS starts_on,
        (make_date(selected_fiscal_year, month_number, 1)
          + interval '1 month - 1 day')::date AS ends_on,
        to_char(make_date(selected_fiscal_year, month_number, 1), 'FMMonth YYYY') AS label
      FROM generate_series(1, 12) AS month_number
    ), classified AS (
      SELECT expected.*,
        numbered.id AS numbered_id,
        numbered.label AS numbered_label,
        numbered.state AS numbered_state,
        numbered.starts_on = expected.starts_on
          AND numbered.ends_on = expected.ends_on AS compatible,
        overlapping.id AS overlapping_id
      FROM expected
      LEFT JOIN LATERAL (
        SELECT period.id, period.label, period.state,
          period.starts_on, period.ends_on
        FROM public.fiscal_periods period
        WHERE period.organization_id = selected_organization_id
          AND period.ledger_id = selected_ledger_id
          AND period.fiscal_year = selected_fiscal_year
          AND period.period_number = expected.period_number
        LIMIT 1
      ) numbered ON true
      LEFT JOIN LATERAL (
        SELECT period.id
        FROM public.fiscal_periods period
        WHERE period.organization_id = selected_organization_id
          AND period.ledger_id = selected_ledger_id
          AND daterange(period.starts_on, period.ends_on, '[]')
            && daterange(expected.starts_on, expected.ends_on, '[]')
          AND period.id IS DISTINCT FROM numbered.id
        ORDER BY period.starts_on, period.period_number, period.id
        LIMIT 1
      ) overlapping ON true
    )
    SELECT jsonb_build_object(
      'accepted', false,
      'idempotentReplay', false,
      'ledgerId', selected_ledger_id,
      'fiscalYear', selected_fiscal_year,
      'periodPattern', 'MONTHLY',
      'initialState', 'OPEN',
      'summary', jsonb_build_object(
        'created', 0,
        'existing', (SELECT count(*) FROM classified WHERE compatible),
        'rejected', greatest(
          (SELECT count(*) FROM classified WHERE NOT coalesce(compatible, false)),
          conflict_count
        )
      ),
      'periods', (
        SELECT jsonb_agg(jsonb_build_object(
          'periodId', CASE WHEN compatible THEN numbered_id ELSE NULL END,
          'periodNumber', period_number,
          'label', CASE WHEN compatible THEN numbered_label ELSE label END,
          'startsOn', starts_on,
          'endsOn', ends_on,
          'state', CASE WHEN compatible THEN numbered_state ELSE NULL END,
          'outcome', CASE WHEN compatible THEN 'ALREADY_EXISTING' ELSE 'REJECTED' END,
          'rejectionCode', CASE
            WHEN compatible THEN NULL
            WHEN numbered_id IS NOT NULL THEN 'INCOMPATIBLE_PERIOD_DEFINITION'
            WHEN overlapping_id IS NOT NULL THEN 'OVERLAPPING_PERIOD'
            ELSE 'BATCH_REJECTED'
          END
        ) ORDER BY period_number)
        FROM classified
      ),
      'conflicts', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'periodId', period.id,
          'fiscalYear', period.fiscal_year,
          'periodNumber', period.period_number,
          'label', period.label,
          'startsOn', period.starts_on,
          'endsOn', period.ends_on,
          'state', period.state,
          'rejectionCode', CASE
            WHEN period.fiscal_year = selected_fiscal_year
              THEN 'INCOMPATIBLE_PERIOD_DEFINITION'
            ELSE 'OVERLAPPING_PERIOD'
          END
        ) ORDER BY period.starts_on, period.period_number, period.id), '[]'::jsonb)
        FROM public.fiscal_periods period
        WHERE period.organization_id = selected_organization_id
          AND period.ledger_id = selected_ledger_id
          AND (
            (
              period.fiscal_year = selected_fiscal_year
              AND NOT EXISTS (
                SELECT 1 FROM expected
                WHERE expected.period_number = period.period_number
                  AND expected.starts_on = period.starts_on
                  AND expected.ends_on = period.ends_on
              )
            )
            OR (
              period.fiscal_year <> selected_fiscal_year
              AND daterange(period.starts_on, period.ends_on, '[]')
                && daterange(
                  make_date(selected_fiscal_year, 1, 1),
                  make_date(selected_fiscal_year, 12, 31),
                  '[]'
                )
            )
          )
      )
    ) INTO response;
    RETURN response;
  END IF;

  WITH expected AS (
    SELECT
      month_number AS period_number,
      make_date(selected_fiscal_year, month_number, 1) AS starts_on,
      (make_date(selected_fiscal_year, month_number, 1)
        + interval '1 month - 1 day')::date AS ends_on
    FROM generate_series(1, 12) AS month_number
  ), inserted AS (
    INSERT INTO public.fiscal_periods(
      organization_id, ledger_id, fiscal_year, period_number,
      label, starts_on, ends_on, state
    )
    SELECT selected_organization_id, selected_ledger_id, selected_fiscal_year,
      expected.period_number, to_char(expected.starts_on, 'FMMonth YYYY'),
      expected.starts_on, expected.ends_on, selected_initial_state
    FROM expected
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.fiscal_periods period
      WHERE period.organization_id = selected_organization_id
        AND period.ledger_id = selected_ledger_id
        AND period.fiscal_year = selected_fiscal_year
        AND period.period_number = expected.period_number
    )
    RETURNING id
  )
  SELECT coalesce(array_agg(inserted.id), ARRAY[]::uuid[])
  INTO created_period_ids
  FROM inserted;

  WITH actual AS (
    SELECT period.id, period.period_number, period.label,
      period.starts_on, period.ends_on, period.state
    FROM public.fiscal_periods period
    WHERE period.organization_id = selected_organization_id
      AND period.ledger_id = selected_ledger_id
      AND period.fiscal_year = selected_fiscal_year
    ORDER BY period.period_number
  )
  SELECT jsonb_build_object(
    'accepted', true,
    'idempotentReplay', false,
    'ledgerId', selected_ledger_id,
    'fiscalYear', selected_fiscal_year,
    'periodPattern', 'MONTHLY',
    'initialState', 'OPEN',
    'summary', jsonb_build_object(
      'created', (SELECT count(*) FROM actual WHERE id = ANY(created_period_ids)),
      'existing', (SELECT count(*) FROM actual WHERE NOT (id = ANY(created_period_ids))),
      'rejected', 0
    ),
    'periods', (
      SELECT jsonb_agg(jsonb_build_object(
        'periodId', id,
        'periodNumber', period_number,
        'label', label,
        'startsOn', starts_on,
        'endsOn', ends_on,
        'state', state,
        'outcome', CASE
          WHEN id = ANY(created_period_ids) THEN 'CREATED'
          ELSE 'ALREADY_EXISTING'
        END,
        'rejectionCode', NULL
      ) ORDER BY period_number)
      FROM actual
    ),
    'conflicts', '[]'::jsonb
  ) INTO response;

  PERFORM app.append_tenant_business_audit(
    selected_organization_id,
    'ledger.fiscal_periods.provisioned',
    'ledger',
    selected_ledger_id::text,
    jsonb_build_object(
      'commandHash', selected_command_hash,
      'result', response
    ),
    NULL
  );
  RETURN response;
END
$$;
REVOKE ALL ON FUNCTION app.accounting_create_fiscal_periods(
  uuid, integer, text, period_state, text
) FROM PUBLIC;
--> statement-breakpoint
