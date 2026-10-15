import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import type { SigninNotificationContext } from "@/modules/identity/signin-notification";
const state = vi.hoisted(() => ({ runtime: null as unknown }));
vi.mock("@/db/transaction", () => ({ queryDatabase: (sql: string, values: unknown[]) => (state.runtime as Pool).query(sql, values) }));
import { issuePasswordUserSession, issueOidcUserSession } from "@/modules/identity/auth-store";
const run = process.env.TEST_DATABASE_URL && process.env.TEST_APP_DATABASE_URL ? describe : describe.skip;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

run("atomic sign-in notification eligibility", () => {
  const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const runtime = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL });
  const fixtures = [0,1].map(() => ({userId:randomUUID(),organizationId:randomUUID(),membershipId:randomUUID()}));
  const original: SigninNotificationContext = {deviceHash:digest("browser-one"),realm:"password",browserLabel:"Chrome on Linux",country:"CA",region:"CA-ON",geoStatus:"COARSE_REGION"};
  beforeAll(async () => {
    state.runtime=runtime;
    for (const f of fixtures) {
      await owner.query("INSERT INTO organizations(id,slug,display_name) VALUES($1,$2,'Synthetic sign-in context')",[f.organizationId,`signin-${f.organizationId}`]);
      await owner.query("INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active,email_verified_at,mfa_required) VALUES($1,$2,'synthetic','synthetic',true,now(),false)",[f.userId,digest(f.userId)]);
      await owner.query("INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES($1,$2,$3,true)",[f.membershipId,f.organizationId,f.userId]);
    }
  });
  afterAll(async () => { state.runtime=null; await Promise.all([owner.end(),runtime.end()]); });
  async function issue(context=original, fixture=fixtures[0]!) {
    const input={...fixture,tokenHash:digest(randomUUID()),ipHash:digest(randomUUID()),userAgentHash:digest("agent"),requestId:randomUUID(),notificationContext:context};
    const sessionId = context.realm==="password" ? await issuePasswordUserSession(input) : await issueOidcUserSession({...input,credentialHash:digest("credential"),mfaAssurance:"NONE"});
    const decision=(await owner.query("SELECT email_queued,reasons,context FROM auth_login_notification_decisions WHERE session_id=$1",[sessionId])).rows[0];
    return {sessionId,input,decision};
  }

  it("uses independent OR novelty and suppresses familiar sign-ins even when IP changes",async()=>{
    const first=await issue();
    expect(first.decision).toMatchObject({email_queued:true,reasons:["NEW_DEVICE","NEW_COUNTRY","NEW_LOCATION"]});
    expect((await issue()).decision).toMatchObject({email_queued:false,reasons:[]});
    expect((await issue({...original,deviceHash:digest("browser-two")})).decision.reasons).toEqual(["NEW_DEVICE"]);
    expect((await issue({...original,country:"US",region:null,geoStatus:"COUNTRY_ONLY"})).decision.reasons).toEqual(["NEW_COUNTRY"]);
    expect((await issue({...original,country:"US",region:"US-CA"})).decision.reasons).toEqual(["NEW_LOCATION"]);
    expect((await issue({...original,deviceHash:digest("browser-three"),country:"GB",region:"GB-ENG"})).decision.reasons).toEqual(["NEW_DEVICE","NEW_COUNTRY","NEW_LOCATION"]);
    const metadata=JSON.stringify(first.decision.context);
    expect(metadata).not.toContain(first.input.tokenHash);
    expect(metadata).not.toContain(original.deviceHash);
    expect(metadata).not.toContain(first.input.ipHash);
  });

  it("records unknown geo explicitly while suppressing a familiar device",async()=>{
    const known=await issue({...original,country:null,region:null,geoStatus:"UNAVAILABLE"});
    expect(known.decision).toMatchObject({email_queued:false,context:{geoStatus:"UNAVAILABLE",country:null,region:null}});
    expect((await issue({...original,deviceHash:digest("cleared-cookie"),country:null,region:null,geoStatus:"LOW_CONFIDENCE"})).decision.reasons).toEqual(["NEW_DEVICE"]);
  });

  it("serializes concurrent baseline training and deduplicates one session's outbox replay",async()=>{
    const context={...original,deviceHash:digest("concurrent-browser")};
    const results=await Promise.all(Array.from({length:6},()=>issue(context)));
    expect(results.filter(result=>result.decision.email_queued)).toHaveLength(1);
    const result=results.find(value=>value.decision.email_queued)!;
    const client=await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.signin_notification_context',$1,true)",[JSON.stringify({...context,sessionTokenHash:result.input.tokenHash})]);
      const duplicate=await client.query("INSERT INTO auth_email_outbox(id,user_id,organization_id,template_type,request_id) VALUES($1,$2,$3,'SECURITY_NEW_LOGIN',$4)",[randomUUID(),result.input.userId,result.input.organizationId,result.input.requestId]);
      expect(duplicate.rowCount).toBe(0);
      await client.query("COMMIT");
    } finally {await client.query("ROLLBACK");client.release();}
    expect((await owner.query("SELECT count(*)::int n FROM auth_email_outbox WHERE user_id=$1 AND request_id=$2",[result.input.userId,result.input.requestId])).rows[0].n).toBe(1);
  });

  it("isolates users and realms and renews expired/security-revoked recognition",async()=>{
    expect((await issue(original,fixtures[1]!)).decision.reasons).toEqual(["NEW_DEVICE","NEW_COUNTRY","NEW_LOCATION"]);
    const oidc={...original,realm:`oidc:${digest("issuer-and-tenant")}`};
    expect((await issue(oidc)).decision.reasons).toEqual(["NEW_DEVICE","NEW_COUNTRY","NEW_LOCATION"]);
    expect((await issue(oidc)).decision.email_queued).toBe(false);
    await owner.query("UPDATE auth_login_contexts SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND realm='password' AND kind='DEVICE'",[fixtures[0]!.userId]);
    expect((await issue()).decision.reasons).toEqual(["NEW_DEVICE"]);
    await owner.query("UPDATE users SET auth_security_epoch=auth_security_epoch+1 WHERE id=$1",[fixtures[0]!.userId]);
    expect((await issue()).decision.reasons).toEqual(["NEW_DEVICE","NEW_COUNTRY","NEW_LOCATION"]);
  });

  it("never trains failed authentication and protects baselines from runtime reads/writes",async()=>{
    const bad=await issue(original,{...fixtures[0]!,membershipId:fixtures[1]!.membershipId});
    expect(bad.sessionId).toBeNull();
    expect(bad.decision).toBeUndefined();
    for (const table of ["auth_login_contexts","auth_login_notification_decisions"]) {
      await expect(runtime.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({code:"42501"});
      await expect(runtime.query(`DELETE FROM ${table}`)).rejects.toMatchObject({code:"42501"});
    }
    await expect(owner.query("UPDATE auth_login_notification_decisions SET email_queued=false WHERE user_id=$1",[fixtures[0]!.userId])).rejects.toThrow(/append-only/);
    const sessions=(await owner.query("SELECT count(*)::int n FROM auth_sessions WHERE user_id=ANY($1::uuid[])",[fixtures.map(f=>f.userId)])).rows[0].n;
    const events=(await owner.query("SELECT count(*)::int n FROM auth_security_events WHERE user_id=ANY($1::uuid[]) AND event_type IN ('LOGIN_PASSWORD','LOGIN_OIDC') AND outcome='SUCCESS'",[fixtures.map(f=>f.userId)])).rows[0].n;
    expect(events).toBe(sessions);
  });
});
