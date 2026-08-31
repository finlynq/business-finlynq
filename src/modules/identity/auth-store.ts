import { queryDatabase } from "@/db/transaction";

export type LoginIdentity = Readonly<{
  user_id: string;
  password_hash: string;
  email_ciphertext: string;
  display_name_ciphertext: string | null;
  email_verified_at: Date | null;
  mfa_required: boolean;
  mfa_factor_id: string | null;
  mfa_secret_ciphertext: string | null;
  mfa_last_accepted_counter: number | null;
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
  mfa_verified_at: Date | null;
  step_up_expires_at: Date | null;
  organization_writes_enabled: boolean;
}>;

export type PasswordResetChallenge = Readonly<{
  recovery_policy: "EMAIL_ONLY" | "TOTP" | "CO_OWNER" | "DELAYED";
  available_at: Date;
  recovery_status: "PENDING" | "APPROVED" | "CONSUMED" | "DENIED";
  factor_id: string | null;
  factor_secret_ciphertext: string | null;
  factor_last_accepted_counter: number | null;
  user_id: string;
  email_ciphertext: string;
  organization_name: string;
  replacement_factor_id: string | null;
  replacement_factor_secret_ciphertext: string | null;
}>;

export type MfaSetupChallenge = Readonly<{
  user_id: string;
  organization_id: string;
  factor_id: string;
  factor_secret_ciphertext: string;
}>;

export type SessionMfaStatus = Readonly<{
  mfa_required: boolean;
  active_factor: boolean;
  pending_enrollment: boolean;
}>;

export type ClaimedEmail = Readonly<{
  outbox_id: string;
  user_id: string;
  email_ciphertext: string;
  template_type: string;
  payload_ciphertext: string | null;
  template_data: Record<string, unknown>;
  attempt: number;
}>;

export type EmailDeliveryReadiness = Readonly<{
  worker_ready: boolean;
  last_heartbeat_at: Date | null;
  oldest_pending_at: Date | null;
  dead_count: string;
  stuck_count: string;
}>;

export async function consumeRateLimit(scope: string, keyHash: string, limit: number, windowSeconds: number) {
  const result = await queryDatabase<{ allowed: boolean; retry_after_seconds: number }>(
    "SELECT * FROM app.auth_consume_rate_limit($1, $2, $3, $4)",
    [scope, keyHash, limit, windowSeconds],
  );
  return result.rows[0] ?? { allowed: false, retry_after_seconds: windowSeconds };
}

type RateLimitDecision = Readonly<{ allowed: boolean; retry_after_seconds: number }>;

async function protectedRateLimit(sql: string, values: readonly unknown[], fallbackSeconds: number): Promise<RateLimitDecision> {
  const result = await queryDatabase<RateLimitDecision>(sql, values);
  return result.rows[0] ?? { allowed: false, retry_after_seconds: fallbackSeconds };
}

export function consumeMfaStepUpLimits(sessionId: string): Promise<RateLimitDecision> {
  return protectedRateLimit("SELECT * FROM app.auth_consume_mfa_step_up_limits($1)", [sessionId], 900);
}

export function consumePasswordResetLimits(tokenHash: string): Promise<RateLimitDecision> {
  return protectedRateLimit("SELECT * FROM app.auth_consume_password_reset_limits($1)", [tokenHash], 3600);
}

export function consumePasswordResetEscalationLimits(tokenHash: string): Promise<RateLimitDecision> {
  return protectedRateLimit("SELECT * FROM app.auth_consume_password_reset_escalation_limits($1)", [tokenHash], 86400);
}

export function consumeRecoveryApprovalLimits(sessionId: string, recoveryRequestId: string): Promise<RateLimitDecision> {
  return protectedRateLimit(
    "SELECT * FROM app.auth_consume_recovery_approval_limits($1,$2)",
    [sessionId, recoveryRequestId],
    3600,
  );
}

export function consumeMfaEnrollmentLimits(setupTokenHash: string): Promise<RateLimitDecision> {
  return protectedRateLimit("SELECT * FROM app.auth_consume_mfa_enrollment_limits($1)", [setupTokenHash], 1800);
}

export async function lookupLogin(emailHash: string): Promise<LoginIdentity[]> {
  const result = await queryDatabase<LoginIdentity>("SELECT * FROM app.auth_lookup_login_v2($1)", [emailHash]);
  return result.rows;
}

export async function issueMfaUserSession(input: {
  userId: string; organizationId: string; membershipId: string; factorId: string; totpCounter: number;
  tokenHash: string; ipHash: string; userAgentHash: string; requestId: string;
  replacedDemoSessionTokenHash?: string | null;
}): Promise<string | null> {
  // The login route supplies a replacement token only after resolving it as a
  // DEMO principal. Keeping issuance and revocation in one PostgreSQL statement
  // prevents a failed replacement from orphaning a newly issued REAL session.
  const result = await queryDatabase<{ session_id: string | null }>(
    `WITH issued AS MATERIALIZED (
       SELECT app.auth_issue_mfa_user_session($1,$2,$3,$4,$5,$6,$7,$8,$9) AS session_id
     ), demo_replacement AS MATERIALIZED (
       SELECT app.auth_revoke_session($10,$9) AS revoked
       FROM issued
       WHERE issued.session_id IS NOT NULL
         AND $10::text IS NOT NULL
     )
     SELECT issued.session_id
     FROM issued
     LEFT JOIN demo_replacement ON true`,
    [input.userId, input.organizationId, input.membershipId, input.factorId, input.totpCounter,
      input.tokenHash, input.ipHash, input.userAgentHash, input.requestId,
      input.replacedDemoSessionTokenHash ?? null],
  );
  return result.rows[0]?.session_id ?? null;
}

export async function issuePasswordUserSession(input: {
  userId: string; organizationId: string; membershipId: string;
  tokenHash: string; ipHash: string; userAgentHash: string; requestId: string;
  replacedDemoSessionTokenHash?: string | null;
}): Promise<string | null> {
  const result = await queryDatabase<{ session_id: string | null }>(
    `WITH issued AS MATERIALIZED (
       SELECT app.auth_issue_password_user_session($1,$2,$3,$4,$5,$6,$7) AS session_id
     ), demo_replacement AS MATERIALIZED (
       SELECT app.auth_revoke_session($8,$7) AS revoked
       FROM issued
       WHERE issued.session_id IS NOT NULL
         AND $8::text IS NOT NULL
     )
     SELECT issued.session_id
     FROM issued
     LEFT JOIN demo_replacement ON true`,
    [input.userId, input.organizationId, input.membershipId, input.tokenHash,
      input.ipHash, input.userAgentHash, input.requestId,
      input.replacedDemoSessionTokenHash ?? null],
  );
  return result.rows[0]?.session_id ?? null;
}

export async function issueDemoSession(input: {
  tokenHash: string;
  claimTokenHash: string | null;
  replacementClaimTokenHash: string;
  ipHash: string;
  userAgentHash: string;
  requestId: string;
}) {
  const result = await queryDatabase<{
    session_id: string; user_id: string; organization_id: string; membership_id: string;
    organization_name: string; role_label: string; claim_created: boolean; claim_expires_at: Date;
  }>("SELECT * FROM app.auth_issue_demo_session($1,$2,$3,$4,$5,$6)", [
    input.tokenHash,
    input.claimTokenHash,
    input.replacementClaimTokenHash,
    input.ipHash,
    input.userAgentHash,
    input.requestId,
  ]);
  return result.rows[0] ?? null;
}

export async function markDemoStepUp(sessionId: string, requestId: string): Promise<boolean> {
  const result = await queryDatabase<{ marked: boolean }>(
    "SELECT app.auth_mark_demo_step_up($1,$2) AS marked",
    [sessionId, requestId],
  );
  return result.rows[0]?.marked ?? false;
}

export async function resolveStoredSession(tokenHash: string, userAgentHash: string | null): Promise<StoredPrincipal | null> {
  const result = await queryDatabase<StoredPrincipal>("SELECT * FROM app.auth_resolve_session_v3($1, $2)", [tokenHash, userAgentHash]);
  const principal = result.rows[0] ?? null;
  if (!principal || principal.session_mode !== "DEMO") return principal;
  const lease = await queryDatabase<{ valid: boolean }>(
    "SELECT app.auth_demo_session_lease_valid($1) AS valid",
    [principal.session_id],
  );
  return lease.rows[0]?.valid ? principal : null;
}

export async function revokeStoredSession(tokenHash: string, requestId: string): Promise<boolean> {
  const result = await queryDatabase<{ revoked: boolean }>("SELECT app.auth_revoke_session($1, $2) AS revoked", [tokenHash, requestId]);
  return result.rows[0]?.revoked ?? false;
}

export async function queuePasswordReset(input: {
  emailHash: string; tokenHash: string; payloadCiphertext: string; outboxId: string; ipHash: string; requestId: string;
}): Promise<void> {
  await queryDatabase("SELECT app.auth_queue_password_reset($1,$2,$3,$4,$5,$6)",
    [input.emailHash, input.tokenHash, input.payloadCiphertext, input.outboxId, input.ipHash, input.requestId]);
}

export async function finishPasswordReset(tokenHash: string, passwordHash: string, requestId: string): Promise<boolean> {
  const result = await queryDatabase<{ finished: boolean }>(
    "SELECT app.auth_finish_password_reset($1, $2, $3) AS finished",
    [tokenHash, passwordHash, requestId],
  );
  return result.rows[0]?.finished ?? false;
}

export async function prepareRecoveryMfa(input: {
  tokenHash: string; factorId: string; factorSecretCiphertext: string; requestId: string;
}): Promise<boolean> {
  const result = await queryDatabase<{ prepared: boolean }>(
    "SELECT app.auth_prepare_recovery_mfa($1,$2,$3,$4) AS prepared",
    [input.tokenHash, input.factorId, input.factorSecretCiphertext, input.requestId],
  );
  return result.rows[0]?.prepared ?? false;
}

export async function finishPasswordResetWithMfa(input: {
  tokenHash: string; passwordHash: string; factorId: string; counter: number; requestId: string;
}): Promise<boolean> {
  const result = await queryDatabase<{ finished: boolean }>(
    "SELECT app.auth_finish_password_reset_with_mfa($1,$2,$3,$4,$5) AS finished",
    [input.tokenHash, input.passwordHash, input.factorId, input.counter, input.requestId],
  );
  return result.rows[0]?.finished ?? false;
}

export async function recordLoginFailure(requestId: string): Promise<void> {
  await queryDatabase("SELECT app.auth_record_login_failure($1)", [requestId]);
}

export async function passwordResetChallenge(tokenHash: string): Promise<PasswordResetChallenge | null> {
  const result = await queryDatabase<PasswordResetChallenge>("SELECT * FROM app.auth_password_reset_challenge($1)", [tokenHash]);
  return result.rows[0] ?? null;
}

export async function authorizePasswordResetTotp(input: {
  tokenHash: string; factorId: string; counter: number; requestId: string;
}): Promise<boolean> {
  const result = await queryDatabase<{ authorized: boolean }>(
    "SELECT app.auth_authorize_password_reset_totp($1,$2,$3,$4) AS authorized",
    [input.tokenHash, input.factorId, input.counter, input.requestId],
  );
  return result.rows[0]?.authorized ?? false;
}

export async function escalatePasswordReset(tokenHash: string, requestId: string) {
  const result = await queryDatabase<{ recovery_policy: "CO_OWNER" | "DELAYED"; available_at: Date }>(
    "SELECT * FROM app.auth_escalate_password_reset($1,$2)", [tokenHash, requestId],
  );
  return result.rows[0] ?? null;
}

export async function acceptInvitation(input: {
  tokenHash: string; passwordHash: string; factorId: string; factorSecretCiphertext: string;
  setupTokenHash: string; requestId: string;
}) {
  const result = await queryDatabase<{ user_id: string; email_ciphertext: string; organization_name: string; factor_id: string }>(
    "SELECT * FROM app.auth_accept_invitation($1,$2,$3,$4,$5,$6)",
    [input.tokenHash, input.passwordHash, input.factorId, input.factorSecretCiphertext, input.setupTokenHash, input.requestId],
  );
  return result.rows[0] ?? null;
}

export async function mfaSetupChallenge(setupTokenHash: string): Promise<MfaSetupChallenge | null> {
  const result = await queryDatabase<MfaSetupChallenge>("SELECT * FROM app.auth_mfa_setup_challenge($1)", [setupTokenHash]);
  return result.rows[0] ?? null;
}

export async function finishMfaEnrollment(input: {
  setupTokenHash: string; factorId: string; counter: number; requestId: string;
}): Promise<boolean> {
  const result = await queryDatabase<{ finished: boolean }>(
    "SELECT app.auth_finish_mfa_enrollment($1,$2,$3,$4) AS finished",
    [input.setupTokenHash, input.factorId, input.counter, input.requestId],
  );
  return result.rows[0]?.finished ?? false;
}

export async function skipMfaEnrollment(setupTokenHash: string, requestId: string): Promise<boolean> {
  const result = await queryDatabase<{ skipped: boolean }>(
    "SELECT app.auth_skip_mfa_enrollment($1,$2) AS skipped",
    [setupTokenHash, requestId],
  );
  return result.rows[0]?.skipped ?? false;
}

export async function mfaStatusForSession(sessionId: string): Promise<SessionMfaStatus | null> {
  const result = await queryDatabase<SessionMfaStatus>(
    "SELECT * FROM app.auth_mfa_status_for_session($1)",
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export async function beginSessionMfaEnrollment(input: {
  sessionId: string; factorId: string; factorSecretCiphertext: string;
  setupTokenHash: string; requestId: string;
}): Promise<boolean> {
  const result = await queryDatabase<{ started: boolean }>(
    "SELECT app.auth_begin_session_mfa_enrollment($1,$2,$3,$4,$5) AS started",
    [input.sessionId, input.factorId, input.factorSecretCiphertext,
      input.setupTokenHash, input.requestId],
  );
  return result.rows[0]?.started ?? false;
}

export async function passwordForSession(sessionId: string): Promise<Readonly<{
  user_id: string;
  password_hash: string;
}> | null> {
  const result = await queryDatabase<{ user_id: string; password_hash: string }>(
    "SELECT * FROM app.auth_password_for_session($1)",
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export async function recordSessionReauthenticationFailure(sessionId: string, requestId: string): Promise<void> {
  await queryDatabase(
    "SELECT app.auth_record_session_reauthentication_failure($1,$2)",
    [sessionId, requestId],
  );
}

export async function finishSessionMfaEnrollment(input: {
  sessionId: string; setupTokenHash: string; factorId: string;
  counter: number; replacementSessionTokenHash: string; requestId: string;
}): Promise<boolean> {
  const result = await queryDatabase<{ finished: boolean }>(
    "SELECT app.auth_finish_session_mfa_enrollment($1,$2,$3,$4,$5,$6) AS finished",
    [input.sessionId, input.setupTokenHash, input.factorId, input.counter,
      input.replacementSessionTokenHash, input.requestId],
  );
  return result.rows[0]?.finished ?? false;
}

export async function totpForSession(sessionId: string) {
  const result = await queryDatabase<{
    factor_id: string; factor_secret_ciphertext: string; factor_last_accepted_counter: number | null;
  }>("SELECT * FROM app.auth_totp_for_session($1)", [sessionId]);
  return result.rows[0] ?? null;
}

export async function markStepUp(input: { sessionId: string; factorId: string; counter: number; requestId: string }) {
  const result = await queryDatabase<{ marked: boolean }>(
    "SELECT app.auth_mark_step_up($1,$2,$3,$4) AS marked",
    [input.sessionId, input.factorId, input.counter, input.requestId],
  );
  return result.rows[0]?.marked ?? false;
}

export async function approveRecovery(input: {
  recoveryRequestId: string; actorSessionId: string; factorId: string; counter: number; requestId: string;
}) {
  const result = await queryDatabase<{ approved: boolean }>(
    "SELECT app.auth_approve_recovery($1,$2,$3,$4,$5) AS approved",
    [input.recoveryRequestId, input.actorSessionId, input.factorId, input.counter, input.requestId],
  );
  return result.rows[0]?.approved ?? false;
}

export async function claimEmailDelivery(workerId: string): Promise<ClaimedEmail | null> {
  const result = await queryDatabase<ClaimedEmail>("SELECT * FROM app.auth_claim_email_delivery($1)", [workerId]);
  return result.rows[0] ?? null;
}

export async function heartbeatEmailDeliveryWorker(workerId: string): Promise<void> {
  await queryDatabase("SELECT app.auth_email_worker_heartbeat($1)", [workerId]);
}

export async function emailDeliveryReadiness(maxHeartbeatAgeSeconds = 15): Promise<EmailDeliveryReadiness> {
  const result = await queryDatabase<EmailDeliveryReadiness>(
    "SELECT * FROM app.auth_email_delivery_readiness($1)",
    [maxHeartbeatAgeSeconds],
  );
  return result.rows[0] ?? {
    worker_ready: false,
    last_heartbeat_at: null,
    oldest_pending_at: null,
    dead_count: "0",
    stuck_count: "0",
  };
}

export async function assertEmailDeliveryReady(maxHeartbeatAgeSeconds = 15): Promise<void> {
  const readiness = await emailDeliveryReadiness(maxHeartbeatAgeSeconds);
  if (!readiness.worker_ready) throw new Error("Authentication email delivery worker is unavailable");
}

export async function completeEmailDelivery(outboxId: string, workerId: string, providerMessageId: string): Promise<boolean> {
  const result = await queryDatabase<{ completed: boolean }>(
    "SELECT app.auth_complete_email_delivery($1,$2,$3) AS completed", [outboxId, workerId, providerMessageId],
  );
  return result.rows[0]?.completed ?? false;
}

export async function failEmailDelivery(outboxId: string, workerId: string, errorCode: string, retryable: boolean): Promise<boolean> {
  const result = await queryDatabase<{ failed: boolean }>(
    "SELECT app.auth_fail_email_delivery($1,$2,$3,$4) AS failed", [outboxId, workerId, errorCode, retryable],
  );
  return result.rows[0]?.failed ?? false;
}
