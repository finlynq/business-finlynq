-- A CHECK constraint must not query another table: PostgreSQL cannot encode
-- that dependency and pg_restore may copy signup rows before currency rows.
-- The foreign key below owns the durable existence invariant instead; signup
-- functions continue to reject inactive definitions through this lookup.
ALTER TABLE "auth_organization_signups"
  DROP CONSTRAINT "auth_organization_signups_supported_currency_check";
--> statement-breakpoint

-- pg_restore intentionally sets an empty session search_path. Keep this
-- constraint helper independent of the caller and of mutable schemas.
CREATE OR REPLACE FUNCTION app.currency_minor_units(currency_code text)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT definition.minor_units
  FROM public.currency_definitions AS definition
  WHERE definition.code = pg_catalog.upper(currency_code)
    AND definition.active
$$;
--> statement-breakpoint

-- Foreign keys are restored after table data, so this validates the reference
-- without making COPY depend on the order of the two tables' data entries.
ALTER TABLE "auth_organization_signups" ADD CONSTRAINT "auth_organization_signups_functional_currency_fk" FOREIGN KEY ("functional_currency") REFERENCES "public"."currency_definitions"("code") ON DELETE restrict ON UPDATE no action;
