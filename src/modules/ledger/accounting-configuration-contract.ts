/**
 * Client-safe accounting-configuration identifiers. Keep this module free of
 * database, session, and `server-only` imports so forms can share the exact
 * segment union without pulling privileged application services into a browser
 * bundle.
 */
export const accountSegmentKeys = [
  "subaccount", "department",
  "custom1", "custom2", "custom3", "custom4",
  "custom5", "custom6", "custom7", "custom8",
] as const;

export type AccountSegmentKey = (typeof accountSegmentKeys)[number];
