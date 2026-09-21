DROP INDEX "tax_filing_canonical_selections_scope_version_unique";--> statement-breakpoint
DROP INDEX "tax_filing_configurations_scope_version_unique";--> statement-breakpoint
ALTER TABLE "tax_filings" ALTER COLUMN "configuration_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_filings" ALTER COLUMN "configuration_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_filing_canonical_selections" ADD CONSTRAINT "tax_filing_canonical_selections_scope_version_unique" UNIQUE NULLS NOT DISTINCT("organization_id","legal_entity_id","registration_id","filing_type_key","period_start","period_end","version");--> statement-breakpoint
ALTER TABLE "tax_filing_configurations" ADD CONSTRAINT "tax_filing_configurations_scope_version_unique" UNIQUE NULLS NOT DISTINCT("organization_id","legal_entity_id","registration_id","filing_type_key","version");