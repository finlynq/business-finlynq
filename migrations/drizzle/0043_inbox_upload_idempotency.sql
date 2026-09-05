ALTER TABLE "document_inbox_items" ADD COLUMN "upload_key" text;--> statement-breakpoint
ALTER TABLE "document_inbox_items" ADD COLUMN "upload_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "document_inbox_items_upload_unique" ON "document_inbox_items" USING btree ("organization_id","connection_id","upload_key");