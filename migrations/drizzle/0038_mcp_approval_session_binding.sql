ALTER TABLE "mcp_approvals" ADD COLUMN "mfa_session_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "direct_write_session_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "direct_write_step_up_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_approvals" ADD CONSTRAINT "mcp_approvals_mfa_session_id_auth_sessions_id_fk" FOREIGN KEY ("mfa_session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_direct_write_session_id_auth_sessions_id_fk" FOREIGN KEY ("direct_write_session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE restrict ON UPDATE no action;