import { readFileSync } from "node:fs";

const ROOT_KEY_BYTES = 32;
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type RootSecretEnvironment = Readonly<Record<string, string | undefined>>;

export type RootSecretLoadOptions = Readonly<{
  environment?: RootSecretEnvironment;
  readTextFile?: (path: string) => string;
}>;

function decodeRootKey(encodedValue: string): Buffer {
  const encoded = encodedValue.trim();

  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(encoded)
  ) {
    throw new Error("Organization root key must be canonical base64");
  }

  const key = Buffer.from(encoded, "base64");
  if (key.length !== ROOT_KEY_BYTES || key.toString("base64") !== encoded) {
    throw new Error(`Organization root key must decode to exactly ${ROOT_KEY_BYTES} bytes`);
  }

  return key;
}

/**
 * Loads the organization wrapping root from a mounted secret file.
 *
 * Inline values remain available for local development and tests, but are
 * deliberately rejected in production so the secret does not enter the
 * container environment or Compose inspection output.
 */
export function loadOrganizationRootKek(options: RootSecretLoadOptions = {}): Buffer {
  const environment = options.environment ?? process.env;
  const readTextFile = options.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
  const secretFile = environment.ORGANIZATION_ROOT_KEK_FILE?.trim();
  const inlineSecret = environment.ORGANIZATION_ROOT_KEK?.trim();

  if (secretFile && inlineSecret) {
    throw new Error("Configure only ORGANIZATION_ROOT_KEK_FILE, not both root-key sources");
  }

  if (secretFile) {
    let encoded: string;
    try {
      encoded = readTextFile(secretFile);
    } catch (error) {
      throw new Error("Unable to read the organization root-key secret file", { cause: error });
    }
    return decodeRootKey(encoded);
  }

  if (inlineSecret && environment.NODE_ENV !== "production") {
    return decodeRootKey(inlineSecret);
  }

  if (inlineSecret) {
    throw new Error("Production requires ORGANIZATION_ROOT_KEK_FILE");
  }

  throw new Error("ORGANIZATION_ROOT_KEK_FILE is required");
}
