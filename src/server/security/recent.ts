import "server-only";

/*
 * "Was this recorded a moment ago?" — used to keep high-volume audit events (file reads, result
 * views) to one row per user and object per window. Bounded: the oldest keys are dropped first.
 * Per server process, like the sign-in throttle; a duplicate row across processes is harmless.
 */

const MAX_KEYS = 20_000;
const seen = new Map<string, number>();

/** True if `key` was seen within `windowMs`; otherwise remembers it now and returns false. */
export function recentlyRecorded(key: string, windowMs = 10 * 60_000, now = Date.now()): boolean {
  const at = seen.get(key);
  if (at !== undefined && now - at < windowMs) return true;
  seen.delete(key);
  seen.set(key, now);
  if (seen.size > MAX_KEYS) seen.delete(seen.keys().next().value!);
  return false;
}

/** Tests: forget everything. */
export function resetRecentlyRecorded() {
  seen.clear();
}
