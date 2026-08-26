import { queryDatabase } from "@/db/transaction";

export type LoginIdentity = Readonly<{
  user_id: string;
  password_hash: string;
  email_ciphertext: string;
  display_name_ciphertext: string | null;
  email_verified_at: Date | null;
  organization_id: string;
  organization_name: string;
  membership_id: string;
  role_label: string;
}>;

export type StoredPrincipal = Readonly<{
  session_id: string;
  user_id: string;
  organization_id: string;
  membership_id: string;
  session_mode: "REAL" | "DEMO";
  auth_method: "PASSWORD" | "DEMO_LINK" | "PASSWORD_RESET";
  organization_name: string;
  role_label: string;
  email_ciphertext: string;
  display_name_ciphertext: string | null;
  expires_at: Date;
}>;

export async function consumeRateLimit(scope: string, keyHash: string, limit: number, windowSeconds: number) {
  const result = await queryDatabase<{ allowed: boolean; retry_after_seconds: number }>(
    "SELECT * FROM app.auth_consume_rate_limit($1, $2, $3, $4)",
    [scope, keyHash, limit, windowSeconds],
  );
  return result.rows[0] ?? { allowed: false, retry_after_seconds: windowSeconds };
}

export async function lookupLogin(emailHash: string): Promise<LoginIdentity[]> {
  const result = await queryDatabase<LoginIdentity>("SELECT * FROM app.auth_lookup_login($1)", [emailHash]);
  return result.rows;
}

export async function issueUserSession(input: {
  userId: string; organizationId: string; membershipId: string; tokenHash: string;
  ipHash: string; userAgentHash: string | null; requestId: string;
}): Promise<string | null> {
  const result = await queryDatabase<{ session_id: string | null }>(
    "SELECT app.auth_issue_user_session($1, $2, $3, $4, $5, $6, $7) AS session_id",
    [input.userId, input.organizationId, input.membershipId, input.tokenHash, input.ipHash, input.userAgentHash, input.requestId],
  );
  return result.rows[0]?.session_id ?? null;
}

export async function issueDemoSession(input: { tokenHash: string; ipHash: string; userAgentHash: string | null; requestId: string }) {
  const result = await queryDatabase<{
    session_id: string; user_id: string; organization_id: string; membership_id: string;
    organization_name: string; role_label: string;
  }>("SELECT * FROM app.auth_issue_demo_session($1, $2, $3, $4)", [input.tokenHash, input.ipHash, input.userAgentHash, input.requestId]);
  return result.rows[0] ?? null;
}

export async function resolveStoredSession(tokenHash: string, userAgentHash: string | null): Promise<StoredPrincipal | null> {
  const result = await queryDatabase<StoredPrincipal>("SELECT * FROM app.auth_resolve_session($1, $2)", [tokenHash, userAgentHash]);
  return result.rows[0] ?? null;
}

export async function revokeStoredSession(tokenHash: string, requestId: string): Promise<boolean> {
  const result = await queryDatabase<{ revoked: boolean }>("SELECT app.auth_revoke_session($1, $2) AS revoked", [tokenHash, requestId]);
  return result.rows[0]?.revoked ?? false;
}

export async function preparePasswordReset(input: { emailHash: string; tokenHash: string; ipHash: string; requestId: string }) {
  const result = await queryDatabase<{ user_id: string; email_ciphertext: string }>(
    "SELECT * FROM app.auth_prepare_password_reset($1, $2, $3, $4)",
    [input.emailHash, input.tokenHash, input.ipHash, input.requestId],
  );
  return result.rows[0] ?? null;
}

export async function finishPasswordReset(tokenHash: string, passwordHash: string, requestId: string): Promise<boolean> {
  const result = await queryDatabase<{ finished: boolean }>(
    "SELECT app.auth_finish_password_reset($1, $2, $3) AS finished",
    [tokenHash, passwordHash, requestId],
  );
  return result.rows[0]?.finished ?? false;
}

export async function recordLoginFailure(requestId: string): Promise<void> {
  await queryDatabase("SELECT app.auth_record_login_failure($1)", [requestId]);
}
