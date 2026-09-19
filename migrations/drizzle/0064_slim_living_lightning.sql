DROP INDEX "sales_invoice_pdf_artifacts_source_unique_v1";--> statement-breakpoint
ALTER TABLE "sales_invoice_pdf_artifacts" ADD CONSTRAINT "sales_invoice_pdf_artifacts_source_unique" UNIQUE NULLS NOT DISTINCT("organization_id","source_document_id","source_version","source_content_hash","template_version","preview","payment_profile_id");
