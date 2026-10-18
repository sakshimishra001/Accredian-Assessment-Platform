import "server-only";

/*
 * Failure-based rate limiting (login throttling).
 *
 * A key (e.g. "ip:203.0.113.7" or "staff:alice@example.com") accumulates failures within a
 * window. The first `freeAttempts` failures are free; each further failure locks the key for an
 * exponentially growing time (base · 2^n, capped). A success clears the key. Keys and their state
 * live in a RateLimitStore — in-process here (bounded, oldest entries evicted first); a shared store
 * (Redis, the database…) can implement the same interface for multi-instance deployments.
 */

export interface ThrottleState {
  failures: number;
  /** When the current counting window started (ms epoch). */
  windowStart: number;
  /** Locked until this time (ms epoch); 0 when not locked. */
  lockedUntil: number;
}

export interface RateLimitStore {
  get(key: string, now: number): ThrottleState | undefined;
  set(key: string, state: ThrottleState, expiresAt: number): void;
  delete(key: string): void;
  clear(): void;
}

/** Bounded in-memory store: entries expire, and the oldest are evicted beyond `maxKeys`. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, { state: ThrottleState; expiresAt: number }>();
  constructor(private readonly maxKeys = 10_000) {}

  get(key: string, now: number) {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return e.state;
  }

  set(key: string, state: ThrottleState, expiresAt: number) {
    // Re-insert so Map order stays "least recently written first".
    this.entries.delete(key);
    this.entries.set(key, { state, expiresAt });
    while (this.entries.size > this.maxKeys) this.entries.delete(this.entries.keys().next().value!);
  }

  delete(key: string) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

export interface ThrottlePolicy {
  /** Failures allowed in a window before locking starts. */
  freeAttempts: number;
  /** Failures older than this (and not locked) are forgotten. */
  windowMs: number;
  /** First lock duration; doubles with each further failure. */
  baseLockMs: number;
  maxLockMs: number;
}

export class FailureThrottle {
  constructor(
    private readonly store: RateLimitStore,
    private readonly policy: ThrottlePolicy,
  ) {}

  /** Milliseconds until the key may try again (0 = allowed now). */
  retryAfter(key: string, now: number): number {
    const s = this.store.get(key, now);
    return s && s.lockedUntil > now ? s.lockedUntil - now : 0;
  }

  /** Record a failure; may lock the key. */
  fail(key: string, now: number) {
    const p = this.policy;
    const prev = this.store.get(key, now);
    const fresh = !prev || (now - prev.windowStart > p.windowMs && prev.lockedUntil <= now);
    const failures = fresh ? 1 : prev.failures + 1;
    const over = failures - p.freeAttempts;
    const lockedUntil = over > 0 ? now + Math.min(p.baseLockMs * 2 ** (over - 1), p.maxLockMs) : 0;
    const state = { failures, windowStart: fresh ? now : prev.windowStart, lockedUntil };
    // Keep the entry until the window or lock is over, whichever is later.
    this.store.set(key, state, Math.max(state.windowStart + p.windowMs, lockedUntil) + 1);
  }

  /** Forget the key (after a successful sign-in). */
  succeed(key: string) {
    this.store.delete(key);
  }
}
