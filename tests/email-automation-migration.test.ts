import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMAIL_MCP_TOOLS } from "@/modules/mcp/email-tools";

const migration = readFileSync(join(process.cwd(), "migrations/drizzle/0063_illegal_jocasta.sql"), "utf8");
const personalAliasMigration = readFileSync(join(process.cwd(), "migrations/drizzle/0076_cuddly_dreadnoughts.sql"), "utf8");
const inboundSource = readFileSync(join(process.cwd(), "src/modules/email/inbound.ts"), "utf8");
const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");

describe("accounting email persistence and MCP boundary", () => {
  it("forces tenant RLS, full-digest routing, immutable evidence, and reviewed grants", () => {
    for (const table of [
      "email_ingestion_aliases", "inbound_email_messages", "inbound_email_attachments",
      "email_booking_rules", "email_booking_evaluations", "email_delivery_settings",
      "payment_instruction_profiles", "customer_delivery_preferences",
      "sales_invoice_pdf_artifacts", "invoice_delivery_attempts", "invoice_delivery_events",
      "email_operation_events",
    ]) {
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(migration).toContain("alias.address_digest=selected_address_digest");
    expect(migration).toContain("address_digest ~ '^[a-f0-9]{64}$'");
    expect(migration).toContain("sales_invoice_pdf_artifacts_append_only");
    expect(migration).toContain("invoice_delivery_events_append_only");
    expect(migration).toContain("REVOKE ALL ON email_ingestion_aliases");
    expect(migration).toContain("app.resolve_inbound_email_alias(text)");
  });

  it("binds one active personal address to an active tenant membership", () => {
    expect(personalAliasMigration).toContain("owner_membership_id");
    expect(personalAliasMigration).toContain("email_ingestion_aliases_active_personal_owner_unique");
    expect(personalAliasMigration).toContain("email_ingestion_aliases_tenant_owner_membership_fk");
    expect(personalAliasMigration).toContain("actor_membership.id=alias.owner_membership_id");
    expect(personalAliasMigration).toContain("actor_membership.active");
    expect(personalAliasMigration).toContain("JOIN users actor ON actor.id=actor_membership.user_id AND actor.active");
    expect(personalAliasMigration).toContain("alias.address_digest=selected_address_digest");
    expect(personalAliasMigration).toContain("REVOKE ALL ON FUNCTION app.resolve_inbound_email_alias(text) FROM PUBLIC");
    expect(inboundSource).toContain("app.lock_active_email_membership(selected_alias.owner_membership_id)");
    expect(personalAliasMigration).toContain("membership.organization_id=app.current_organization_id()");
    expect(personalAliasMigration).toContain("membership.user_id=app.current_actor_id()");
    expect(personalAliasMigration).toContain("FOR SHARE OF membership,actor");
  });

  it("mounts separate accounting provider and webhook secrets only through files", () => {
    expect(compose).toContain("ACCOUNTING_EMAIL_RESEND_API_KEY_FILE: /run/secrets/business_finlynq_accounting_resend_api_key");
    expect(compose).toContain("ACCOUNTING_EMAIL_INBOUND_WEBHOOK_SECRET_FILE: /run/secrets/business_finlynq_accounting_email_inbound_webhook_secret");
    expect(compose).toContain("ACCOUNTING_EMAIL_OUTBOUND_WEBHOOK_SECRET_FILE: /run/secrets/business_finlynq_accounting_email_outbound_webhook_secret");
    expect(compose).not.toMatch(/^\s+ACCOUNTING_EMAIL_RESEND_API_KEY:/m);
  });

  it("publishes setup, daily, safety, retry, and retention tools with unique names", () => {
    const names = EMAIL_MCP_TOOLS.map((tool) => tool.policy.name);
    expect(names).toHaveLength(23);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("finlynq_setup_create_email_ingestion_address");
    expect(names).toContain("finlynq_daily_process_email_payable");
    expect(names).toContain("finlynq_daily_generate_sales_invoice_pdf");
    expect(names).toContain("finlynq_daily_send_sales_invoice");
    expect(names).toContain("finlynq_daily_clear_email_quarantine");
    expect(names).toContain("finlynq_daily_run_email_retention");
    const clear = EMAIL_MCP_TOOLS.find((tool) => tool.policy.name === "finlynq_daily_clear_email_quarantine");
    expect(clear?.policy.mfaRequirement).toBe("REQUIRED");
    expect(clear?.destructive).toBe(true);
  });
});
