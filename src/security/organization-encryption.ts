import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type WrappedKey = Readonly<{
  provider: string;
  keyVersion: number;
  iv: string;
  ciphertext: string;
  authTag: string;
}>;

export type EncryptedField = Readonly<{
  algorithm: "AES-256-GCM";
  keyVersion: number;
  iv: string;
  ciphertext: string;
  authTag: string;
}>;

export type FieldEncryptionContext = Readonly<{
  organizationId: string;
  table: string;
  column: string;
  recordId: string;
  keyVersion: number;
}>;

const ENVELOPE_FORMAT = "business-finlynq-wrapped-key-v1";
const FIELD_FORMAT = "business-finlynq-encrypted-field-v1";

export interface KeyProvider {
  readonly name: string;
  wrapOrganizationKey(organizationId: string, keyVersion: number, dek: Buffer): WrappedKey;
  unwrapOrganizationKey(organizationId: string, wrapped: WrappedKey): Buffer;
}

function assertKey(key: Buffer, label: string): void {
  if (key.length !== 32) {
    throw new Error(`${label} must contain exactly 32 bytes`);
  }
}

function organizationKeyAad(organizationId: string, keyVersion: number): Buffer {
  return Buffer.from(`business-finlynq|org-key|${organizationId}|${keyVersion}`, "utf8");
}

function fieldAad(context: FieldEncryptionContext): Buffer {
  return Buffer.from(
    [
      "business-finlynq",
      "field",
      context.organizationId,
      context.table,
      context.column,
      context.recordId,
      context.keyVersion,
    ].join("|"),
    "utf8",
  );
}

export class LocalRootKeyProvider implements KeyProvider {
  readonly name = "local-root-v1";

  constructor(private readonly rootKey: Buffer) {
    assertKey(rootKey, "Root wrapping key");
  }

  static fromBase64(value: string): LocalRootKeyProvider {
    return new LocalRootKeyProvider(Buffer.from(value, "base64"));
  }

  wrapOrganizationKey(organizationId: string, keyVersion: number, dek: Buffer): WrappedKey {
    assertKey(dek, "Organization DEK");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.rootKey, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(organizationKeyAad(organizationId, keyVersion));
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);

    return {
      provider: this.name,
      keyVersion,
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  unwrapOrganizationKey(organizationId: string, wrapped: WrappedKey): Buffer {
    if (wrapped.provider !== this.name) {
      throw new Error(`Unsupported key provider: ${wrapped.provider}`);
    }

    const decipher = createDecipheriv(
      ALGORITHM,
      this.rootKey,
      Buffer.from(wrapped.iv, "base64"),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(organizationKeyAad(organizationId, wrapped.keyVersion));
    decipher.setAuthTag(Buffer.from(wrapped.authTag, "base64"));
    const dek = Buffer.concat([
      decipher.update(Buffer.from(wrapped.ciphertext, "base64")),
      decipher.final(),
    ]);
    assertKey(dek, "Unwrapped organization DEK");
    return dek;
  }
}

export function generateOrganizationDek(): Buffer {
  return randomBytes(32);
}

export function encryptField(
  plaintext: string,
  organizationDek: Buffer,
  context: FieldEncryptionContext,
): EncryptedField {
  assertKey(organizationDek, "Organization DEK");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, organizationDek, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(fieldAad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    algorithm: "AES-256-GCM",
    keyVersion: context.keyVersion,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptField(
  encrypted: EncryptedField,
  organizationDek: Buffer,
  context: FieldEncryptionContext,
): string {
  assertKey(organizationDek, "Organization DEK");

  if (encrypted.algorithm !== "AES-256-GCM" || encrypted.keyVersion !== context.keyVersion) {
    throw new Error("Encrypted field metadata does not match the requested context");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    organizationDek,
    Buffer.from(encrypted.iv, "base64"),
    { authTagLength: TAG_BYTES },
  );
  decipher.setAAD(fieldAad(context));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function sameKey(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function serializeWrappedKey(wrapped: WrappedKey): string {
  return JSON.stringify({ format: ENVELOPE_FORMAT, ...wrapped });
}

export function parseWrappedKey(value: string): WrappedKey {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") throw new Error("Wrapped organization key is invalid");
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.format !== ENVELOPE_FORMAT ||
    typeof candidate.provider !== "string" ||
    !Number.isSafeInteger(candidate.keyVersion) ||
    typeof candidate.iv !== "string" ||
    typeof candidate.ciphertext !== "string" ||
    typeof candidate.authTag !== "string"
  ) {
    throw new Error("Wrapped organization key metadata is invalid");
  }
  return {
    provider: candidate.provider,
    keyVersion: candidate.keyVersion as number,
    iv: candidate.iv,
    ciphertext: candidate.ciphertext,
    authTag: candidate.authTag,
  };
}

export function serializeEncryptedField(encrypted: EncryptedField): string {
  return JSON.stringify({ format: FIELD_FORMAT, ...encrypted });
}

export function parseEncryptedField(value: string): EncryptedField {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") throw new Error("Encrypted field is invalid");
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.format !== FIELD_FORMAT ||
    candidate.algorithm !== "AES-256-GCM" ||
    !Number.isSafeInteger(candidate.keyVersion) ||
    typeof candidate.iv !== "string" ||
    typeof candidate.ciphertext !== "string" ||
    typeof candidate.authTag !== "string"
  ) {
    throw new Error("Encrypted field metadata is invalid");
  }
  return {
    algorithm: "AES-256-GCM",
    keyVersion: candidate.keyVersion as number,
    iv: candidate.iv,
    ciphertext: candidate.ciphertext,
    authTag: candidate.authTag,
  };
}

export function normalizeBlindIndexValue(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  if (!normalized) throw new Error("Blind-indexed values cannot be blank");
  return normalized;
}

/**
 * Creates an equality-search token using a purpose-specific key derived from
 * the organization DEK. The token cannot be used to decrypt the source value.
 */
export function createBlindIndex(
  value: string,
  organizationDek: Buffer,
  organizationId: string,
  purpose: string,
): string {
  assertKey(organizationDek, "Organization DEK");
  const normalizedPurpose = purpose.trim().toLocaleLowerCase("en-US");
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(normalizedPurpose)) {
    throw new Error("Blind-index purpose must be a canonical application key");
  }
  const searchKey = Buffer.from(hkdfSync(
    "sha256",
    organizationDek,
    Buffer.from(organizationId, "utf8"),
    Buffer.from(`business-finlynq|blind-index|${normalizedPurpose}`, "utf8"),
    32,
  ));
  const digest = createHmac("sha256", searchKey)
    .update(normalizeBlindIndexValue(value), "utf8")
    .digest("hex");
  searchKey.fill(0);
  return `hmac-sha256-v1:${digest}`;
}
