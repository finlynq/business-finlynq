/**
 * Public, non-identifying guidance for the coarse signup request limit. The
 * response deliberately says nothing about whether an email address or
 * organization already exists.
 */
export function signupRateLimitMessage(retryAfter: string | null): string {
  const seconds = retryAfter && /^\d+$/.test(retryAfter)
    ? Number.parseInt(retryAfter, 10)
    : null;
  if (seconds === null || !Number.isSafeInteger(seconds) || seconds <= 0) {
    return "Too many account signup attempts were received. Please wait before trying again.";
  }
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Too many account signup attempts were received. Please wait about ${minutes} ${minutes === 1 ? "minute" : "minutes"} before trying again.`;
}
