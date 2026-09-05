CREATE TABLE "mcp_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mcp_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"arguments_hash" text NOT NULL,
	"arguments_summary" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "mcp_approvals_status_check" CHECK ("mcp_approvals"."status" IN ('PENDING','APPROVED','REJECTED','CONSUMED','EXPIRED'))
);
--> statement-breakpoint
CREATE TABLE "mcp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"scopes" text[] NOT NULL,
	"daily_mode" text DEFAULT 'CONFIRM_WRITES' NOT NULL,
	"setup_mode" text DEFAULT 'OFF' NOT NULL,
	"tool_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "mcp_connections_daily_mode_check" CHECK ("mcp_connections"."daily_mode" IN ('OFF','READ_ONLY','CONFIRM_WRITES','ALLOW_WRITES')),
	CONSTRAINT "mcp_connections_setup_mode_check" CHECK ("mcp_connections"."setup_mode" IN ('OFF','READ_ONLY','CONFIRM_WRITES','ALLOW_WRITES'))
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"grant_types" text[] DEFAULT '{"authorization_code","refresh_token"}' NOT NULL,
	"response_types" text[] DEFAULT '{"code"}' NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_clients_name_length" CHECK (length("mcp_oauth_clients"."client_name") BETWEEN 1 AND 120),
	CONSTRAINT "mcp_oauth_clients_redirects_present" CHECK (cardinality("mcp_oauth_clients"."redirect_uris") BETWEEN 1 AND 20),
	CONSTRAINT "mcp_oauth_clients_public_only" CHECK ("mcp_oauth_clients"."token_endpoint_auth_method" = 'none')
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" text[] NOT NULL,
	"code_challenge" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "mcp_oauth_codes_challenge_check" CHECK ("mcp_oauth_codes"."code_challenge" ~ '^[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
CREATE TABLE "mcp_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mcp_tool_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"tool_group" text NOT NULL,
	"write_action" boolean NOT NULL,
	"arguments_hash" text NOT NULL,
	"approval_id" uuid,
	"status" text NOT NULL,
	"result_summary" jsonb,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "mcp_tool_executions_group_check" CHECK ("mcp_tool_executions"."tool_group" IN ('DAILY','SETUP','SHARED')),
	CONSTRAINT "mcp_tool_executions_status_check" CHECK ("mcp_tool_executions"."status" IN ('STARTED','APPROVAL_REQUIRED','SUCCEEDED','FAILED'))
);
--> statement-breakpoint
ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_client_id_mcp_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_oauth_clients"("client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_approvals" ADD CONSTRAINT "mcp_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_approvals" ADD CONSTRAINT "mcp_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_approvals" ADD CONSTRAINT "mcp_approvals_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_client_id_mcp_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_oauth_clients"("client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_membership_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_client_id_mcp_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_oauth_clients"("client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_refresh_tokens" ADD CONSTRAINT "mcp_refresh_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_refresh_tokens" ADD CONSTRAINT "mcp_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_refresh_tokens" ADD CONSTRAINT "mcp_refresh_tokens_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_refresh_tokens" ADD CONSTRAINT "mcp_refresh_tokens_client_id_mcp_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_oauth_clients"("client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_executions" ADD CONSTRAINT "mcp_tool_executions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_executions" ADD CONSTRAINT "mcp_tool_executions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_executions" ADD CONSTRAINT "mcp_tool_executions_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_executions" ADD CONSTRAINT "mcp_tool_executions_approval_id_mcp_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."mcp_approvals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_access_tokens_hash_unique" ON "mcp_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_access_tokens_connection_idx" ON "mcp_access_tokens" USING btree ("organization_id","connection_id","revoked_at","expires_at");--> statement-breakpoint
CREATE INDEX "mcp_approvals_pending_idx" ON "mcp_approvals" USING btree ("organization_id","user_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_one_active_client_user_unique" ON "mcp_connections" USING btree ("organization_id","user_id","client_id") WHERE "mcp_connections"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "mcp_connections_org_user_idx" ON "mcp_connections" USING btree ("organization_id","user_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_codes_hash_unique" ON "mcp_oauth_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_codes_org_expiry_idx" ON "mcp_oauth_codes" USING btree ("organization_id","expires_at","consumed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_refresh_tokens_hash_unique" ON "mcp_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_refresh_tokens_family_idx" ON "mcp_refresh_tokens" USING btree ("organization_id","family_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tool_executions_request_unique" ON "mcp_tool_executions" USING btree ("organization_id","connection_id","request_id");--> statement-breakpoint
CREATE INDEX "mcp_tool_executions_org_started_idx" ON "mcp_tool_executions" USING btree ("organization_id","started_at");