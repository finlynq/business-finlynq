ALTER TABLE "asset_tax_classifications" DROP CONSTRAINT "asset_tax_classifications_amount_check";--> statement-breakpoint
ALTER TABLE "asset_tax_classifications" ADD COLUMN "cost_before_sales_tax" numeric(38, 9) NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_tax_classifications" ADD COLUMN "recoverable_sales_tax" numeric(38, 9) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_tax_classifications" ADD COLUMN "non_recoverable_sales_tax" numeric(38, 9) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_tax_classifications" ADD COLUMN "eligibility_evidence" text NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_tax_classifications" ADD COLUMN "elections" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_tax_classifications" ADD CONSTRAINT "asset_tax_classifications_elections_check" CHECK (jsonb_typeof(elections) = 'array');--> statement-breakpoint
ALTER TABLE "asset_tax_classifications" ADD CONSTRAINT "asset_tax_classifications_amount_check" CHECK (cost_before_sales_tax > 0 AND recoverable_sales_tax >= 0 AND non_recoverable_sales_tax >= 0 AND tax_capital_cost = cost_before_sales_tax + non_recoverable_sales_tax AND assistance >= 0 AND assistance <= tax_capital_cost);