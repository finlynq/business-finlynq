export const ACCOUNT_SEGMENT_KEYS = [
  "entity",
  "account",
  "subaccount",
  "department",
  "intercompany",
  "custom1",
  "custom2",
  "custom3",
  "custom4",
  "custom5",
  "custom6",
  "custom7",
  "custom8",
] as const;

export type AccountSegmentKey = (typeof ACCOUNT_SEGMENT_KEYS)[number];

export type AccountSegments = Readonly<Record<AccountSegmentKey, string | null>>;

export const SYSTEM_NULL_SEGMENT = "0000";

const USER_SEGMENT_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,15}$/;

export function validateUserSegmentCode(value: string): string {
  const code = value.trim().toUpperCase();

  if (code === SYSTEM_NULL_SEGMENT) {
    throw new Error(`${SYSTEM_NULL_SEGMENT} is reserved for an unused segment`);
  }

  if (!USER_SEGMENT_PATTERN.test(code)) {
    throw new Error("Segment codes must use 1–16 uppercase letters, numbers, underscores, or hyphens");
  }

  return code;
}

export function validateAccountSegments(segments: AccountSegments): void {
  if (!segments.entity) {
    throw new Error("Entity segment is required");
  }

  if (!segments.account) {
    throw new Error("Natural account segment is required");
  }

  for (const key of ACCOUNT_SEGMENT_KEYS) {
    const value = segments[key];
    if (value !== null) {
      validateUserSegmentCode(value);
    }
  }
}

export function renderAccountKey(segments: AccountSegments): string {
  validateAccountSegments(segments);
  return ACCOUNT_SEGMENT_KEYS.map((key) => segments[key] ?? SYSTEM_NULL_SEGMENT).join(".");
}

export type CustomSlotState =
  | "EMPTY"
  | "CONFIGURED_UNBOUND"
  | "ACTIVE_LOCKED"
  | "INACTIVE_LOCKED";

export type CustomSlotTransition = Readonly<{
  from: CustomSlotState;
  to: CustomSlotState;
  hasProtectedUse: boolean;
  hasRestrictedAdminApproval: boolean;
}>;

export function canTransitionCustomSlot(input: CustomSlotTransition): boolean {
  const { from, to, hasProtectedUse, hasRestrictedAdminApproval } = input;

  if (from === to) return true;
  if (from === "EMPTY" && to === "CONFIGURED_UNBOUND") return hasRestrictedAdminApproval;
  if (from === "CONFIGURED_UNBOUND" && to === "ACTIVE_LOCKED") return true;

  if (from === "CONFIGURED_UNBOUND" && to === "EMPTY") {
    return !hasProtectedUse && hasRestrictedAdminApproval;
  }

  if (from === "ACTIVE_LOCKED" && to === "INACTIVE_LOCKED") return hasRestrictedAdminApproval;
  if (from === "INACTIVE_LOCKED" && to === "ACTIVE_LOCKED") return hasRestrictedAdminApproval;

  return false;
}
