import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULT_PERIOD_SECONDS = 30;
const DEFAULT_DIGITS = 6;

export function encodeBase32(value: Buffer): string {
  let bits = 0;
  let accumulator = 0;
  let output = "";
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(accumulator << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replaceAll(/[-\s=]/g, "");
  if (!normalized || [...normalized].some((character) => !ALPHABET.includes(character))) {
    throw new Error("Invalid base32 value");
  }
  let bits = 0;
  let accumulator = 0;
  const output: number[] = [];
  for (const character of normalized) {
    accumulator = (accumulator << 5) | ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function createTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function totpCode(
  secret: string,
  counter: number,
  digits = DEFAULT_DIGITS,
): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("Invalid TOTP counter");
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new Error("Invalid TOTP digit count");
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counterBytes).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, "0");
}

export function verifyTotp(
  secret: string,
  candidate: string,
  at = Date.now(),
  window = 1,
): number | null {
  if (!/^\d{6}$/.test(candidate) || !Number.isFinite(at)) return null;
  const currentCounter = Math.floor(at / 1000 / DEFAULT_PERIOD_SECONDS);
  const supplied = Buffer.from(candidate, "ascii");
  for (let delta = -window; delta <= window; delta += 1) {
    const counter = currentCounter + delta;
    if (counter < 0) continue;
    const expected = Buffer.from(totpCode(secret, counter), "ascii");
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return counter;
  }
  return null;
}

export function totpEnrollmentUri(input: { secret: string; account: string; issuer?: string }): string {
  const issuer = input.issuer ?? "Business Finlynq";
  const label = `${issuer}:${input.account}`;
  const query = new URLSearchParams({ secret: input.secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}
