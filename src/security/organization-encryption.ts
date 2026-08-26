import {
  createCipheriv,
  createDecipheriv,
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
