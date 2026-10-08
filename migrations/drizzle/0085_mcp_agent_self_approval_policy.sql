CREATE TABLE "mcp_agent_self_approval_policy" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled_by" uuid,
	"enabled_at" timestamp with time zone,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_agent_self_approval_policy_version_check" CHECK ("mcp_agent_self_approval_policy"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "journal_approvals" ADD COLUMN "mcp_self_approval_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_agent_self_approval_policy" ADD CONSTRAINT "mcp_agent_self_approval_policy_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_agent_self_approval_policy" ADD CONSTRAINT "mcp_agent_self_approval_policy_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_agent_self_approval_policy" ADD CONSTRAINT "mcp_agent_self_approval_policy_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;