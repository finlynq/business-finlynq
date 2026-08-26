import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
const KEY_BYTES = 64;
const COST = 32_768;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 64 * 1024 * 1024;
const PREFIX = "scrypt-v1";
const DUMMY_SALT = Buffer.from("7Aai5thFuOjh+JpASvV1Vw==", "base64");

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_BYTES, {
      N: COST,
      r: BLOCK_SIZE,
      p: PARALLELIZATION,
      maxmem: MAX_MEMORY,
    }, (error, derivedKey) => error ? reject(error) : resolve(Buffer.from(derivedKey)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return [PREFIX, COST, BLOCK_SIZE, PARALLELIZATION, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [prefix, cost, blockSize, parallelization, saltValue, hashValue, extra] = encoded.split("$");
  const structurallyValid = prefix === PREFIX && Number(cost) === COST && Number(blockSize) === BLOCK_SIZE &&
    Number(parallelization) === PARALLELIZATION && Boolean(saltValue) && Boolean(hashValue) && !extra;

  if (!structurallyValid) {
    await derive(password, DUMMY_SALT);
    return false;
  }

  try {
    const expected = Buffer.from(hashValue, "base64");
    const actual = await derive(password, Buffer.from(saltValue, "base64"));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    await derive(password, DUMMY_SALT);
    return false;
  }
}

export async function consumeDummyPasswordCheck(password: string): Promise<void> {
  await derive(password, DUMMY_SALT);
}
