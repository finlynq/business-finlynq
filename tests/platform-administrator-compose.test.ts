import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");
const serviceStart = compose.indexOf("  grant_platform_administrator:");
const serviceEnd = compose.indexOf("\n  edge:", serviceStart);
const service = compose.slice(serviceStart, serviceEnd);

describe("platform administrator provisioning container", () => {
  it("is an explicit one-shot owner operation with the identity secret", () => {
    expect(serviceStart).toBeGreaterThan(-1);
    expect(serviceEnd).toBeGreaterThan(serviceStart);
    expect(service).toContain("profiles: [account-operations]");
    expect(service).toContain('target: migrator');
    expect(service).toContain('entrypoint: ["npm", "run", "auth:grant-platform-admin", "--"]');
    expect(service).toContain("BUSINESS_FINLYNQ_MIGRATION_DB_USER: business_finlynq_owner");
    expect(service).toContain("BUSINESS_FINLYNQ_MIGRATION_DB_PASSWORD:");
    expect(service).toContain("IDENTITY_SECRET_FILE: /run/secrets/business_finlynq_identity_secret");
    expect(service).toContain("- business_finlynq_identity_secret");
    expect(service).toContain('restart: "no"');
  });

  it("has a read-only, capability-free, private-network boundary without provider credentials", () => {
    expect(service).toContain("read_only: true");
    expect(service).toContain("no-new-privileges:true");
    expect(service).toContain("cap_drop: [ALL]");
    expect(service).toContain("networks: [business_finlynq_private]");
    expect(service).not.toContain("business_finlynq_egress");
    expect(service).not.toContain("RESEND_API_KEY");
    expect(service).not.toContain("business_finlynq_resend_api_key");
    expect(service).not.toContain("AUTH_EMAIL_PROVIDER");
  });
});
