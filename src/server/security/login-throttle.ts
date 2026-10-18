import "server-only";
import { FailureThrottle, MemoryRateLimitStore, type RateLimitStore } from "./rate-limit";

/*
 * Sign-in throttling for staff (password) and learner (exam password) logins.
 *
 *   per IP              30 failures / 15 min free, then 1 min lock doubling up to 30 min
 *   per account + IP     5 failures / 15 min free, then 30 s lock doubling up to 15 min
 *   per account (any IP) 20 failures / 60 min free, then 1 min lock doubling up to 30 min
 *
 * The account+IP key stops guessing quickly without letting one person lock someone else out from
 * elsewhere; the account-wide key still caps distributed guessing against one account. A blocked
 * attempt gets exactly the same response as a wrong password (callers must keep timing similar).
 * IP addresses come from the proxy's X-Forwarded-For header; without one, only the account keys apply.
 */

export type LoginKind = "staff" | "exam";

const MIN = 60_000;
let store: RateLimitStore = new MemoryRateLimitStore(20_000);
const make = (s: RateLimitStore) => ({
  ip: new FailureThrottle(s, { freeAttempts: 30, windowMs: 15 * MIN, baseLockMs: MIN, maxLockMs: 30 * MIN }),
  accountIp: new FailureThrottle(s, { freeAttempts: 5, windowMs: 15 * MIN, baseLockMs: 30_000, maxLockMs: 15 * MIN }),
  account: new FailureThrottle(s, { freeAttempts: 20, windowMs: 60 * MIN, baseLockMs: MIN, maxLockMs: 30 * MIN }),
});
let throttles = make(store);

function keys(kind: LoginKind, email: string, ip: string | null | undefined) {
  const account = `${kind}:${email.trim().toLowerCase()}`;
  return {
    ip: ip ? `ip:${ip}` : null,
    accountIp: `${account}@${ip ?? "unknown"}`,
    account,
  };
}

/** Milliseconds until this sign-in may be attempted (0 = allowed now). */
export function loginRetryAfter(kind: LoginKind, email: string, ip: string | null | undefined, now = Date.now()): number {
  const k = keys(kind, email, ip);
  return Math.max(k.ip ? throttles.ip.retryAfter(k.ip, now) : 0, throttles.accountIp.retryAfter(k.accountIp, now), throttles.account.retryAfter(k.account, now));
}

/** A wrong email/password (or exam password): counts against the IP and the account. */
export function recordLoginFailure(kind: LoginKind, email: string, ip: string | null | undefined, now = Date.now()) {
  const k = keys(kind, email, ip);
  if (k.ip) throttles.ip.fail(k.ip, now);
  throttles.accountIp.fail(k.accountIp, now);
  throttles.account.fail(k.account, now);
}

/** A successful sign-in clears the account's counters (the IP's are left to expire). */
export function recordLoginSuccess(kind: LoginKind, email: string, ip: string | null | undefined) {
  const k = keys(kind, email, ip);
  throttles.accountIp.succeed(k.accountIp);
  throttles.account.succeed(k.account);
}

/** Tests: forget all counters, optionally swapping the store. */
export function resetLoginThrottle(next?: RateLimitStore) {
  store.clear();
  if (next) {
    store = next;
    throttles = make(store);
  }
}
