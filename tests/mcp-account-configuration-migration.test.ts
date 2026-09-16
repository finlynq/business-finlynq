import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "migrations/drizzle/0055_mcp_account_configuration_controls.sql",
  "utf8",
);
const transactionBoundary = readFileSync("src/db/transaction.ts", "utf8");

describe("MCP account-configuration database controls", () => {
  it("narrows destructive journal correction from administrators to owners", () => {
    expect(migration).toContain("NEW.active AND NEW.key = 'OWNER'");
    expect(migration).toContain("role.key = 'ORGANIZATION_ADMIN'");
    expect(migration).toContain("DELETE FROM role_permissions");
    expect(migration).toContain("journal_transaction_controls_owner_guard");
    expect(migration).toContain("role.active AND role.key = 'OWNER'");
  });

  it("revalidates the exact persistent MCP connection without reviving browser sessions", () => {
    expect(transactionBoundary).toContain("set_config('app.mcp_connection_id'");
    expect(migration).toContain("selected_mcp_connection_id");
    expect(migration).toContain("connection.id = selected_mcp_connection_id");
    expect(migration).toContain("connection.direct_write_session_id = selected_session_id");
    expect(migration).toContain("connection.revoked_at IS NULL");
    expect(migration).toContain("membership.active");
    expect(migration).toContain("uses_persistent_mcp_authorization");
    expect(migration).not.toContain("UPDATE auth_sessions");
  });

  it("allows earlier account validity while rejecting dates after existing dependencies", () => {
    expect(migration).toContain("NEW.valid_from > OLD.valid_from");
    expect(migration).toContain("entry.accounting_date < NEW.valid_from");
    expect(migration).toContain("document.snapshot->>'accountingDate'");
    expect(migration).toContain("document.snapshot->'lines'");
    expect(migration).toContain("external_account.created_at::date < NEW.valid_from");
    expect(migration).toContain("Account validity cannot start after an existing accounting dependency");
    expect(migration).not.toContain("NEW.valid_from IS DISTINCT FROM OLD.valid_from");
  });
});
