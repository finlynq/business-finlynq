export type AccountSegmentDefinition = Readonly<{
  key: string;
  displayName: string;
  visible: boolean;
}>;

export type DisplayedAccountSegment = Readonly<{
  key: string;
  displayName: string;
  code: string;
}>;

export type AccountKeyPresentation = Readonly<{
  canonicalKey: string;
  displayKey: string;
  displaySegments: readonly DisplayedAccountSegment[];
}>;

const ACCOUNT_KEY_SEGMENTS = [
  { key: "entity", displayName: "Entity", alwaysVisible: true },
  { key: "account", displayName: "Account", alwaysVisible: true },
  { key: "subaccount", displayName: "Subaccount", alwaysVisible: false },
  { key: "department", displayName: "Department", alwaysVisible: false },
  { key: "intercompany", displayName: "Intercompany", alwaysVisible: false },
  { key: "custom1", displayName: "Custom 1", alwaysVisible: false },
  { key: "custom2", displayName: "Custom 2", alwaysVisible: false },
  { key: "custom3", displayName: "Custom 3", alwaysVisible: false },
  { key: "custom4", displayName: "Custom 4", alwaysVisible: false },
  { key: "custom5", displayName: "Custom 5", alwaysVisible: false },
  { key: "custom6", displayName: "Custom 6", alwaysVisible: false },
  { key: "custom7", displayName: "Custom 7", alwaysVisible: false },
  { key: "custom8", displayName: "Custom 8", alwaysVisible: false },
] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PostgreSQL jsonb values are normally decoded before they reach this helper, but
 * accepting JSON text keeps the presentation boundary robust for alternate pg
 * drivers and focused test doubles.
 */
export function parseAccountSegmentDefinitions(
  value: unknown,
): readonly AccountSegmentDefinition[] {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(candidate)) return [];
  return candidate.flatMap((item) => {
    if (!isRecord(item) || typeof item.key !== "string") return [];
    const key = item.key.trim().toLowerCase();
    if (!key) return [];
    return [{
      key,
      displayName: typeof item.displayName === "string" && item.displayName.trim()
        ? item.displayName.trim()
        : typeof item.display_name === "string" && item.display_name.trim()
          ? item.display_name.trim()
          : key,
      visible: item.visible !== false,
    }];
  });
}

/**
 * Produces a UI-only key. The canonical key is returned unchanged so posting,
 * hashing, audit evidence, and persisted account-combination identity never
 * depend on organization display preferences.
 */
export function presentAccountKey(
  canonicalKey: string,
  unparsedDefinitions: unknown,
): AccountKeyPresentation {
  const codes = canonicalKey.split(".");
  const definitions = new Map(
    parseAccountSegmentDefinitions(unparsedDefinitions).map((definition) => [
      definition.key,
      definition,
    ]),
  );
  const displaySegments = ACCOUNT_KEY_SEGMENTS.flatMap((segment, index) => {
    const code = codes[index];
    if (code === undefined) return [];
    const configured = definitions.get(segment.key);
    if (!segment.alwaysVisible && configured?.visible === false) return [];
    return [{
      key: segment.key,
      displayName: configured?.displayName ?? segment.displayName,
      code,
    }];
  });
  return {
    canonicalKey,
    displayKey: displaySegments.map((segment) => segment.code).join("."),
    displaySegments,
  };
}

export function accountKeyDisplayTitle(
  segments: readonly DisplayedAccountSegment[],
): string {
  return segments.map((segment) => `${segment.displayName}: ${segment.code}`).join(" · ");
}
