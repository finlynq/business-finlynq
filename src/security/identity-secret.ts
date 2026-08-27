import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const SECRET_BYTES = 64;
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PREFIX = "idv1";
const AUTH_PAYLOAD_PREFIX = "authv1";

type IdentitySecretEnvironment = Readonly<Record<string, string | undefined>>;

function decodeSecret(encodedValue: string): Buffer {
  const encoded = encodedValue.trim();
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !CANONICAL_BASE64.test(encoded)) {
    throw new Error("Identity secret must be canonical base64");
  }
  const secret = Buffer.from(encoded, "base64");
  if (secret.length !== SECRET_BYTES || secret.toString("base64") !== encoded) {
    throw new Error(`Identity secret must decode to exactly ${SECRET_BYTES} bytes`);
  }
  return secret;
}

export function loadIdentitySecret(
  environment: IdentitySecretEnvironment = process.env,
  readTextFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Buffer {
  const secretFile = environment.IDENTITY_SECRET_FILE?.trim();
  const inlineSecret = environment.IDENTITY_SECRET?.trim();
  if (secretFile && inlineSecret) throw new Error("Configure only one identity-secret source");

  if (secretFile) {
    try {
      return decodeSecret(readTextFile(secretFile));
    } catch (error) {
      throw new Error("Unable to load the identity secret file", { cause: error });
    }
  }
  if (inlineSecret && environment.NODE_ENV !== "production") return decodeSecret(inlineSecret);
  if (inlineSecret) throw new Error("Production requires IDENTITY_SECRET_FILE");
  throw new Error("IDENTITY_SECRET_FILE is required");
}

function keys(secret: Buffer): { encryption: Buffer; lookup: Buffer } {
  if (secret.length !== SECRET_BYTES) throw new Error("Identity secret has an invalid length");
  return { encryption: secret.subarray(0, 32), lookup: secret.subarray(32, 64) };
}

export function normalizeEmail(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

export function identityLookupHash(value: string, secret = loadIdentitySecret()): string {
  return createHmac("sha256", keys(secret).lookup)
    .update(`business-finlynq|identity-lookup|${value}`, "utf8")
    .digest("hex");
}

export function emailLookupHash(email: string, secret = loadIdentitySecret()): string {
  return identityLookupHash(`email|${normalizeEmail(email)}`, secret);
}

export function encryptIdentityField(
  plaintext: string,
  field: "email" | "display-name",
  userId: string,
  secret = loadIdentitySecret(),
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys(secret).encryption, iv);
  cipher.setAAD(Buffer.from(`business-finlynq|identity|${field}|${userId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(":");
}

export function decryptIdentityField(
  envelope: string,
  field: "email" | "display-name",
  userId: string,
  secret = loadIdentitySecret(),
): string {
  const [prefix, iv, ciphertext, tag, extra] = envelope.split(":");
  if (prefix !== PREFIX || !iv || !ciphertext || !tag || extra) throw new Error("Invalid identity field envelope");
  const decipher = createDecipheriv("aes-256-gcm", keys(secret).encryption, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(`business-finlynq|identity|${field}|${userId}`, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * Encrypt short-lived authentication material before it is placed in the
 * durable delivery outbox. The purpose and record id are authenticated so an
 * envelope cannot be replayed as a different message or factor.
 */
export function encryptAuthPayload(
  plaintext: string,
  purpose: "email-payload" | "totp-secret",
  recordId: string,
  secret = loadIdentitySecret(),
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys(secret).encryption, iv);
  cipher.setAAD(Buffer.from(`business-finlynq|auth|${purpose}|${recordId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [AUTH_PAYLOAD_PREFIX, iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(":");
}

export function decryptAuthPayload(
  envelope: string,
  purpose: "email-payload" | "totp-secret",
  recordId: string,
  secret = loadIdentitySecret(),
): string {
  const [prefix, iv, ciphertext, tag, extra] = envelope.split(":");
  if (prefix !== AUTH_PAYLOAD_PREFIX || !iv || !ciphertext || !tag || extra) {
    throw new Error("Invalid authentication payload envelope");
  }
  const decipher = createDecipheriv("aes-256-gcm", keys(secret).encryption, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(`business-finlynq|auth|${purpose}|${recordId}`, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
