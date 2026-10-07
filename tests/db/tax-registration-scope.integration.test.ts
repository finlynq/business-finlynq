import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabasePool } from "@/db/transaction";
import { LocalRootKeyProvider, serializeWrappedKey } from "@/security/organization-encryption";
import { loadOrganizationRootKek } from "@/security/root-secret";
import { configureTaxRegistration, correctTaxRegistrationScope, taxRegistrationConfigurationSchema } from "@/modules/ledger/accounting-configuration";
import type { SessionPrincipal } from "@/modules/identity/session";

const run = process.env.TEST_DATABASE_URL && process.env.TEST_APP_DATABASE_URL ? describe : describe.skip;
const ids = { org: randomUUID(), other: randomUUID(), actor: randomUUID(), entity: randomUUID(), role: randomUUID(), membership: randomUUID(), session: randomUUID() };
const principal: SessionPrincipal = { sessionId: ids.session, userId: ids.actor, organizationId: ids.org, membershipId: ids.membership, organizationName: "Tax scope test", roleLabel: "Owner", displayName: "Tester", initials: "T", sessionMode: "real", authMethod: "PASSWORD", expiresAt: new Date(Date.now() + 3600000), mfaVerifiedAt: new Date(), stepUpExpiresAt: new Date(Date.now() + 3600000), organizationWritesEnabled: true };
run("tax registration scope correction", () => {
  const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let registrationId: string;
  beforeAll(async () => {
    vi.stubEnv("BUSINESS_WRITES_ENABLED", "true");
    await owner.query("INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at) VALUES ($1,$2,'Tax scope',true,false,'REAL',now()),($3,$4,'Other tax scope',true,false,'REAL',now())", [ids.org, 'tax-' + ids.org, ids.other, 'tax-' + ids.other]);
    await owner.query("INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active) VALUES ($1,$2,'encrypted','test',true)", [ids.actor, ids.actor]);
    await owner.query("INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES ($1,$2,$3,true)", [ids.membership, ids.org, ids.actor]);
    await owner.query("INSERT INTO roles(id,organization_id,key,display_name) VALUES ($1,$2,'TAX_SCOPE_TEST','Tax scope test')", [ids.role, ids.org]);
    await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) VALUES ($1,$2,'organization.settings.manage')", [ids.org, ids.role]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES ($1,$2,$3,$4)", [ids.org, ids.membership, ids.role, ids.actor]);
    await owner.query(`INSERT INTO auth_sessions(id,token_hash,user_id,organization_id,membership_id,auth_method,session_mode,user_agent_hash,idle_timeout_seconds,idle_expires_at,expires_at,mfa_verified_at,step_up_expires_at) VALUES ($1::uuid,$1::text,$2,$3,$4,'PASSWORD','REAL',repeat('b',64),7200,now()+interval '2 hours',now()+interval '24 hours',now(),now()+interval '2 hours')`, [ids.session, ids.actor, ids.org, ids.membership]);
    await owner.query("INSERT INTO legal_entities(id,organization_id,code,display_name,country_code,region_code,active) VALUES ($1,$2,'TAX','Tax company','CA','ON',true)", [ids.entity, ids.org]);
    const root = loadOrganizationRootKek(), dek = randomBytes(32);
    try { const wrapped = new LocalRootKeyProvider(root).wrapOrganizationKey(ids.org, 1, dek); await owner.query("INSERT INTO organization_key_versions(organization_id,version,key_provider,wrapped_dek,active) VALUES ($1,1,$2,$3,true)", [ids.org, wrapped.provider, serializeWrappedKey(wrapped)]); }
    finally { root.fill(0); dek.fill(0); }
    await owner.query("INSERT INTO tax_pack_versions(id,pack_key,version,jurisdiction,effective_from,source_uri,source_digest,approved_by,approved_at) VALUES ($1,'ca.on.hst','synthetic-v1','CA-ON','2026-01-01','https://example.test/synthetic',repeat('a',64),$2,now()) ON CONFLICT DO NOTHING", [randomUUID(), ids.actor]);
    const fields = taxRegistrationConfigurationSchema.parse({ legalEntityId: ids.entity, regimeKey: "ca.on.hst", registrationReference: "SYNTHETIC-ONLY", destinationCountry: "CA", destinationRegion: "ON", destinationCity: "Toronto", locationCode: null, configurationEvidence: "Synthetic original city scope", validFrom: "2026-01-01", validTo: null, reason: "Synthetic registration test" });
    registrationId = (await configureTaxRegistration({ principal, requestId: randomUUID(), ...fields })).id;
  });
  afterAll(async () => { vi.unstubAllEnvs(); await closeDatabasePool(); await owner.end(); });
  it("corrects Ontario to province scope without changing original registration and audits a replay-safe version", async () => {
    const fields = { principal, requestId: randomUUID(), registrationId, expectedScopeVersion: 1, destinationCity: null, locationCode: null,
      configurationEvidence: "Ontario HST applies to the province", reason: "Correct legacy city binding", preservePostedEvidence: true as const, idempotencyKey: randomUUID() };
    const result = await correctTaxRegistrationScope(fields);
    expect(result).toMatchObject({ registrationId, scopeVersion: 2, preservedPostedEvidenceCount: 0, idempotentReplay: false });
    expect(await correctTaxRegistrationScope({ ...fields, requestId: randomUUID() })).toMatchObject({ correctionId: result.correctionId, idempotentReplay: true });
    await expect(correctTaxRegistrationScope({ ...fields, requestId: randomUUID(), idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "TAX_REGISTRATION_SCOPE_STALE" });
    await expect(correctTaxRegistrationScope({ ...fields, requestId: randomUUID(), expectedScopeVersion: 2, destinationCity: "Ottawa", idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "TAX_REGISTRATION_PROVINCE_SCOPE_REQUIRED" });
    const registration = (await owner.query("SELECT destination_city FROM entity_tax_registrations WHERE id=$1", [registrationId])).rows[0];
    const history = (await owner.query("SELECT version,destination_city,location_code,reason FROM tax_registration_scope_versions WHERE registration_id=$1", [registrationId])).rows;
    expect(registration.destination_city).toBe("Toronto");
    expect(history).toMatchObject([{ version: 2, destination_city: null, location_code: null, reason: "Correct legacy city binding" }]);
    const audit = await owner.query("SELECT id FROM audit_events WHERE organization_id=$1 AND action='accounting.tax_registration.scope-corrected'", [ids.org]);
    expect(audit.rows).toHaveLength(1);
  });
  it("offers correction for overlap, denies another tenant and rejects missing administrator permission", async () => {
    const fields = taxRegistrationConfigurationSchema.parse({ legalEntityId: ids.entity, regimeKey: "ca.on.hst", registrationReference: "SYNTHETIC-OVERLAP", destinationCountry: "CA", destinationRegion: "ON", destinationCity: "Ottawa", locationCode: null, configurationEvidence: "Synthetic overlapping test", validFrom: "2026-06-01", validTo: null, reason: "Synthetic overlap test" });
    await expect(configureTaxRegistration({ principal, requestId: randomUUID(), ...fields })).rejects.toMatchObject({ code: "TAX_REGISTRATION_OVERLAP" });
    const correction = { principal, requestId: randomUUID(), registrationId: randomUUID(), expectedScopeVersion: 1, destinationCity: null, locationCode: null, configurationEvidence: "Synthetic wrong-company correction", reason: "Correct a wrong company", preservePostedEvidence: true as const, idempotencyKey: randomUUID() };
    await expect(correctTaxRegistrationScope(correction)).rejects.toMatchObject({ code: "TAX_REGISTRATION_UNAVAILABLE" });
    await owner.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2", [ids.org, ids.role]);
    try { await expect(correctTaxRegistrationScope({ ...correction, registrationId, expectedScopeVersion: 2, idempotencyKey: randomUUID() })).rejects.toThrow(); }
    finally { await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) VALUES ($1,$2,'organization.settings.manage')", [ids.org, ids.role]); }
  });
});
