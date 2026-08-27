import "server-only";

import { randomUUID } from "node:crypto";
import {
  LocalRootKeyProvider,
  generateOrganizationDek,
  serializeWrappedKey,
} from "@/security/organization-encryption";
import {
  decryptIdentityField,
  emailLookupHash,
  encryptAuthPayload,
  encryptIdentityField,
  identityDerivedUuid,
  loadIdentitySecret,
  normalizeEmail,
} from "@/security/identity-secret";
import { loadOrganizationRootKek } from "@/security/root-secret";
import { hashPassword } from "./passwords";
import { createOpaqueToken, hashOpaqueToken } from "./session";
import {
  CURRENT_SIGNUP_TERMS_VERSION,
  signupCountryDefaults,
  type SignupCountry,
} from "./signup-policy";
import {
  acceptOrganizationSignup,
  beginOrganizationSignup,
  consumeSignupAcceptLimits,
  type SignupPostingMode,
} from "./signup-store";
import { createTotpSecret, totpEnrollmentUri } from "./totp";

export type OwnerSignupRequest = Readonly<{
  email: string;
  displayName: string;
  organizationName: string;
  entityCode: string;
  entityName: string;
  countryCode: SignupCountry;
  regionCode: string;
  fiscalYear: number;
  manualPostingMode: SignupPostingMode;
  ipHash: string;
  requestId: string;
}>;

export async function requestOwnerSignup(input: OwnerSignupRequest): Promise<boolean> {
  const identitySecret = loadIdentitySecret();
  const rootKey = loadOrganizationRootKek();
  const dek = generateOrganizationDek();
  try {
    const email = normalizeEmail(input.email);
    const emailHash = emailLookupHash(email, identitySecret);
    // Invitations and owner signup share one secret-derived identity key so an
    // unverified placeholder cannot squat the email under a second user id.
    const userId = identityDerivedUuid("account-user", emailHash, identitySecret);
    const organizationId = identityDerivedUuid("organization-signup-organization", emailHash, identitySecret);
    const signupId = identityDerivedUuid("organization-signup-request", emailHash, identitySecret);
    const slug = `business-${organizationId.replaceAll("-", "").slice(0, 20)}`;
    const token = createOpaqueToken();
    const tokenId = randomUUID();
    const outboxId = randomUUID();
    const wrapped = new LocalRootKeyProvider(rootKey).wrapOrganizationKey(organizationId, 1, dek);
    const countryDefaults = signupCountryDefaults(input.countryCode);

    return await beginOrganizationSignup({
      signupId,
      userId,
      organizationId,
      tokenId,
      emailHash,
      emailCiphertext: encryptIdentityField(email, "email", userId, identitySecret),
      displayNameCiphertext: encryptIdentityField(input.displayName, "display-name", userId, identitySecret),
      organizationSlug: slug,
      organizationName: input.organizationName,
      entityCode: input.entityCode,
      entityName: input.entityName,
      countryCode: input.countryCode,
      regionCode: input.regionCode,
      functionalCurrency: countryDefaults.functionalCurrency,
      accountingProfile: countryDefaults.accountingProfile,
      fiscalYear: input.fiscalYear,
      manualPostingMode: input.manualPostingMode,
      keyProvider: wrapped.provider,
      wrappedDek: serializeWrappedKey(wrapped),
      tokenHash: token.hash,
      payloadCiphertext: encryptAuthPayload(
        JSON.stringify({ token: token.raw }),
        "email-payload",
        outboxId,
        identitySecret,
      ),
      outboxId,
      ipHash: input.ipHash,
      requestId: input.requestId,
      termsVersion: CURRENT_SIGNUP_TERMS_VERSION,
    });
  } finally {
    dek.fill(0);
    rootKey.fill(0);
    identitySecret.fill(0);
  }
}

export type OwnerSignupAcceptance =
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "rate-limited"; retryAfterSeconds: number }>
  | Readonly<{
      status: "accepted";
      setupToken: string;
      secret: string;
      enrollmentUri: string;
      organizationName: string;
    }>;

export async function acceptOwnerSignup(input: Readonly<{
  token: string;
  password: string;
  requestId: string;
}>): Promise<OwnerSignupAcceptance> {
  const tokenHash = hashOpaqueToken(input.token);
  const limits = await consumeSignupAcceptLimits(tokenHash);
  if (!limits.eligible) return { status: "invalid" };
  if (!limits.allowed) {
    return { status: "rate-limited", retryAfterSeconds: limits.retry_after_seconds };
  }

  const factorId = randomUUID();
  const secret = createTotpSecret();
  const setupToken = createOpaqueToken();
  const passwordHash = await hashPassword(input.password);
  const result = await acceptOrganizationSignup({
    tokenHash,
    passwordHash,
    factorId,
    factorSecretCiphertext: encryptAuthPayload(secret, "totp-secret", factorId),
    setupTokenHash: setupToken.hash,
    requestId: input.requestId,
  });
  if (!result) return { status: "invalid" };
  const email = decryptIdentityField(result.email_ciphertext, "email", result.user_id);
  return {
    status: "accepted",
    setupToken: setupToken.raw,
    secret,
    enrollmentUri: totpEnrollmentUri({ secret, account: email }),
    organizationName: result.organization_name,
  };
}
