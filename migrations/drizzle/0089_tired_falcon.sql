CREATE TABLE "organization_guidance_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"path" text NOT NULL,
	"summary" text NOT NULL,
	"content" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"changed_by" uuid NOT NULL,
	"request_id" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_guidance_status_check" CHECK ("organization_guidance_files"."status" IN ('ACTIVE','RETIRED')),
	CONSTRAINT "organization_guidance_version_check" CHECK ("organization_guidance_files"."version" > 0),
	CONSTRAINT "organization_guidance_path_check" CHECK (length("organization_guidance_files"."path") BETWEEN 4 AND 120),
	CONSTRAINT "organization_guidance_content_check" CHECK (octet_length("organization_guidance_files"."content") <= 12000)
);
--> statement-breakpoint
CREATE TABLE "platform_guidance_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"summary" text NOT NULL,
	"content" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"changed_by" uuid,
	"request_id" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_guidance_status_check" CHECK ("platform_guidance_files"."status" IN ('ACTIVE','RETIRED')),
	CONSTRAINT "platform_guidance_version_check" CHECK ("platform_guidance_files"."version" > 0),
	CONSTRAINT "platform_guidance_path_check" CHECK (length("platform_guidance_files"."path") BETWEEN 4 AND 120),
	CONSTRAINT "platform_guidance_content_check" CHECK (octet_length("platform_guidance_files"."content") <= 12000)
);
--> statement-breakpoint
ALTER TABLE "organization_guidance_files" ADD CONSTRAINT "organization_guidance_files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_guidance_files" ADD CONSTRAINT "organization_guidance_files_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_guidance_files" ADD CONSTRAINT "platform_guidance_files_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_guidance_path_version_unique" ON "organization_guidance_files" USING btree ("organization_id","path","version");--> statement-breakpoint
CREATE INDEX "organization_guidance_path_recent_idx" ON "organization_guidance_files" USING btree ("organization_id","path","version");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_guidance_path_version_unique" ON "platform_guidance_files" USING btree ("path","version");--> statement-breakpoint
CREATE INDEX "platform_guidance_path_recent_idx" ON "platform_guidance_files" USING btree ("path","version");