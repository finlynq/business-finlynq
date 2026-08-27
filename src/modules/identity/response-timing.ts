import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Password-recovery requests always wait for the same minimum envelope. Email
 * delivery happens out of band, so account existence does not add provider
 * latency to the response.
 */
export async function settleSensitiveResponse(
  startedAt: number,
  options: { minimumMs?: number; jitterMs?: number; now?: () => number; wait?: (milliseconds: number) => Promise<unknown> } = {},
): Promise<void> {
  const minimumMs = options.minimumMs ?? 400;
  const jitterMs = options.jitterMs ?? randomInt(0, 101);
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds: number) => delay(milliseconds));
  const remaining = Math.max(0, minimumMs + jitterMs - (now() - startedAt));
  if (remaining > 0) await wait(remaining);
}
