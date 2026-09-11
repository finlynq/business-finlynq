import "server-only";

import { queryDatabase } from "@/db/transaction";

export type SignupAccountingProfile = "CAN_ASPE" | "US_GAAP_NONPUBLIC";
export type SignupPostingMode = "REVIEW_REQUIRED" | "AUTO_POST";

export type OidcSignupIdentity = Readonly<{
  issuer: string;
  externalTenantId: string;
  externalPrincipalId: string;
  credentialHash: string;
}>;

export type BeginOrganizationSignup = Readonly<{
  signupId: string;
  userId: string;
  organizationId: string;
  tokenId: string;
  emailHash: string;
  emailCiphertext: string;
  displayNameCiphertext: string;
  organizationSlug: string;
  organizationName: string;
  entityCode: string;
  entityName: string;
  countryCode: string;
  regionCode: string;
  functionalCurrency: string;
  accountingProfile: SignupAccountingProfile;
  fiscalYear: number;
  manualPostingMode: SignupPostingMode;
  keyProvider: string;
  wrappedDek: string;
  tokenHash: string;
  payloadCiphertext: string;
  outboxId: string;
  ipHash: string;
  requestId: string;
  termsVersion: string;
}>;

export async function beginOrganizationSignup(
  input: BeginOrganizationSignup,
  oidcIdentity: OidcSignupIdentity | null = null,
): Promise<boolean> {
  const result = await queryDatabase<{ queued: boolean }>(
    `WITH begun AS MATERIALIZED (
       SELECT app.auth_begin_organization_signup(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25
       ) AS queued
     ), configured AS MATERIALIZED (
       SELECT app.auth_configure_organization_signup_oidc(
         $1,$22,$26,$27,$28,$29
       ) AS configured
       FROM begun
       WHERE begun.queued
     )
     SELECT begun.queued AND coalesce(configured.configured, false) AS queued
     FROM begun
     LEFT JOIN configured ON true`,
    [
      input.signupId,
      input.userId,
      input.organizationId,
      input.tokenId,
      input.emailHash,
      input.emailCiphertext,
      input.displayNameCiphertext,
      input.organizationSlug,
      input.organizationName,
      input.entityCode,
      input.entityName,
      input.countryCode,
      input.regionCode,
      input.functionalCurrency,
      input.accountingProfile,
      input.fiscalYear,
      input.manualPostingMode,
      input.keyProvider,
      input.wrappedDek,
      input.tokenHash,
      input.payloadCiphertext,
      input.outboxId,
      input.ipHash,
      input.requestId,
      input.termsVersion,
      oidcIdentity?.issuer ?? null,
      oidcIdentity?.externalTenantId ?? null,
      oidcIdentity?.externalPrincipalId ?? null,
      oidcIdentity?.credentialHash ?? null,
    ],
  );
  return result.rows[0]?.queued ?? false;
}

export async function acceptOidcOrganizationSignup(input: Readonly<{
  tokenHash: string;
  passwordHash: string;
  passwordEnabled: boolean;
  factorId: string;
  factorSecretCiphertext: string;
  setupTokenHash: string;
  requestId: string;
  oidcIdentity: OidcSignupIdentity;
}>): Promise<Readonly<{
  user_id: string;
  email_ciphertext: string;
  organization_name: string;
  factor_id: string;
}> | null> {
  const result = await queryDatabase<{
    user_id: string;
    email_ciphertext: string;
    organization_name: string;
    factor_id: string;
  }>(
    "SELECT * FROM app.auth_accept_oidc_organization_signup($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      input.tokenHash,
      input.passwordHash,
      input.passwordEnabled,
      input.factorId,
      input.factorSecretCiphertext,
      input.setupTokenHash,
      input.requestId,
      input.oidcIdentity.issuer,
      input.oidcIdentity.externalTenantId,
      input.oidcIdentity.externalPrincipalId,
    ],
  );
  return result.rows[0] ?? null;
}

export type SignupAcceptRateLimit = Readonly<{
  eligible: boolean;
  allowed: boolean;
  retry_after_seconds: number;
}>;

export async function consumeSignupAcceptLimits(tokenHash: string): Promise<SignupAcceptRateLimit> {
  const result = await queryDatabase<SignupAcceptRateLimit>(
    "SELECT * FROM app.auth_consume_signup_accept_limits($1)",
    [tokenHash],
  );
  return result.rows[0] ?? { eligible: false, allowed: false, retry_after_seconds: 3600 };
}

export async function acceptOrganizationSignup(input: Readonly<{
  tokenHash: string;
  passwordHash: string;
  factorId: string;
  factorSecretCiphertext: string;
  setupTokenHash: string;
  requestId: string;
}>): Promise<Readonly<{
  user_id: string;
  email_ciphertext: string;
  organization_name: string;
  factor_id: string;
}> | null> {
  const result = await queryDatabase<{
    user_id: string;
    email_ciphertext: string;
    organization_name: string;
    factor_id: string;
  }>(
    "SELECT * FROM app.auth_accept_local_organization_signup($1,$2,$3,$4,$5,$6)",
    [
      input.tokenHash,
      input.passwordHash,
      input.factorId,
      input.factorSecretCiphertext,
      input.setupTokenHash,
      input.requestId,
    ],
  );
  return result.rows[0] ?? null;
}
