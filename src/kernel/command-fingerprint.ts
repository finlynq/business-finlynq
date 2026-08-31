import { createHash } from "node:crypto";

export const COMMAND_FINGERPRINT_NAMESPACE = "business-finlynq.command-fingerprint";
export const CURRENT_COMMAND_FINGERPRINT_VERSION = "v1";

const componentPattern = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function serializeCanonicalValue(value: unknown, ancestors: Set<object>): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    throw new TypeError("Command fingerprints do not support bigint values");
  }
  if (typeof value !== "object") {
    throw new TypeError(`Command fingerprints do not support ${typeof value} values`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("Command fingerprints do not support cyclic values");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = Array.from(
        { length: value.length },
        (_, index) => serializeCanonicalValue(value[index], ancestors) ?? "null",
      );
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Command fingerprints accept only plain objects and arrays");
    }
    const fields = Object.keys(value)
      .sort(compareKeys)
      .flatMap((key) => {
        const serialized = serializeCanonicalValue((value as Record<string, unknown>)[key], ancestors);
        return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
      });
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Produces deterministic JSON without changing array order or decimal strings.
 * Undefined object fields are omitted; undefined array positions become null,
 * matching JSON's index-preserving behavior.
 */
export function canonicalCommandSerialization(value: unknown): string {
  const serialized = serializeCanonicalValue(value, new Set());
  if (serialized === undefined) {
    throw new TypeError("A command fingerprint payload must be JSON-serializable");
  }
  return serialized;
}

export function createCommandFingerprint(
  domain: string,
  payload: unknown,
  version = CURRENT_COMMAND_FINGERPRINT_VERSION,
): string {
  if (!componentPattern.test(domain)) {
    throw new TypeError("Command fingerprint domain must be a canonical lowercase application key");
  }
  if (!componentPattern.test(version)) {
    throw new TypeError("Command fingerprint version must be a canonical lowercase application key");
  }
  const preimage = [
    COMMAND_FINGERPRINT_NAMESPACE,
    `version=${version}`,
    `domain=${domain}`,
    `payload=${canonicalCommandSerialization(payload)}`,
  ].join("\n");
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

export type TransitionalCommandFingerprints = Readonly<{
  current: string;
  legacy: string;
}>;

export function matchesStoredCommandFingerprint(
  stored: string | null | undefined,
  fingerprints: TransitionalCommandFingerprints,
): boolean {
  return stored === fingerprints.current || stored === fingerprints.legacy;
}
