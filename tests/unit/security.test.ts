import { beforeEach, describe, expect, it } from "vitest";
import { contentSecurityPolicy, newNonce } from "@/lib/security/csp";
import { loginRetryAfter, recordLoginFailure, recordLoginSuccess, resetLoginThrottle } from "@/server/security/login-throttle";
import { FailureThrottle, MemoryRateLimitStore } from "@/server/security/rate-limit";

const SEC = 1000;
const MIN = 60 * SEC;

describe("FailureThrottle", () => {
  const policy = { freeAttempts: 3, windowMs: 10 * MIN, baseLockMs: 30 * SEC, maxLockMs: 4 * MIN };

  it("allows the free attempts, then locks with exponential backoff up to the cap", () => {
    const t = new FailureThrottle(new MemoryRateLimitStore(), policy);
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      t.fail("k", now);
      expect(t.retryAfter("k", now)).toBe(0);
    }
    t.fail("k", now);
    expect(t.retryAfter("k", now)).toBe(30 * SEC);
    t.fail("k", now);
    expect(t.retryAfter("k", now)).toBe(60 * SEC);
    t.fail("k", now);
    expect(t.retryAfter("k", now)).toBe(120 * SEC);
    for (let i = 0; i < 5; i++) t.fail("k", now);
    expect(t.retryAfter("k", now)).toBe(4 * MIN);
  });

  it("unlocks when the lock expires, forgets old failures, and a success clears the key", () => {
    const t = new FailureThrottle(new MemoryRateLimitStore(), policy);
    let now = 0;
    for (let i = 0; i < 4; i++) t.fail("k", now);
    expect(t.retryAfter("k", now + 29 * SEC)).toBeGreaterThan(0);
    expect(t.retryAfter("k", now + 30 * SEC)).toBe(0);

    // After the window, counting starts again from zero.
    now += 11 * MIN;
    t.fail("k", now);
    expect(t.retryAfter("k", now)).toBe(0);

    for (let i = 0; i < 5; i++) t.fail("k", now);
    expect(t.retryAfter("k", now)).toBeGreaterThan(0);
    t.succeed("k");
    expect(t.retryAfter("k", now)).toBe(0);
  });

  it("keys are independent", () => {
    const t = new FailureThrottle(new MemoryRateLimitStore(), policy);
    for (let i = 0; i < 4; i++) t.fail("a", 0);
    expect(t.retryAfter("a", 0)).toBeGreaterThan(0);
    expect(t.retryAfter("b", 0)).toBe(0);
  });
});

describe("MemoryRateLimitStore", () => {
  it("is bounded: the oldest keys are evicted first", () => {
    const store = new MemoryRateLimitStore(3);
    for (const k of ["a", "b", "c", "d"]) store.set(k, { failures: 1, windowStart: 0, lockedUntil: 0 }, 1_000);
    expect(store.size).toBe(3);
    expect(store.get("a", 0)).toBeUndefined();
    expect(store.get("d", 0)).toBeDefined();
  });

  it("drops expired entries", () => {
    const store = new MemoryRateLimitStore();
    store.set("a", { failures: 1, windowStart: 0, lockedUntil: 0 }, 100);
    expect(store.get("a", 99)).toBeDefined();
    expect(store.get("a", 100)).toBeUndefined();
    expect(store.size).toBe(0);
  });
});

describe("login throttle policy", () => {
  beforeEach(() => resetLoginThrottle());
  const fail = (n: number, email: string, ip: string | null, now: number) => {
    for (let i = 0; i < n; i++) recordLoginFailure("staff", email, ip, now);
  };

  it("pauses an account after 5 failures from one IP without locking it out from elsewhere", () => {
    fail(5, "a@example.com", "10.0.0.1", 0);
    expect(loginRetryAfter("staff", "a@example.com", "10.0.0.1", 0)).toBe(0);
    fail(1, "a@example.com", "10.0.0.1", 0);
    expect(loginRetryAfter("staff", "a@example.com", "10.0.0.1", 0)).toBe(30 * SEC);
    expect(loginRetryAfter("staff", "A@Example.com ", "10.0.0.1", 0)).toBe(30 * SEC);
    expect(loginRetryAfter("staff", "a@example.com", "10.0.0.2", 0)).toBe(0);
    expect(loginRetryAfter("exam", "a@example.com", "10.0.0.1", 0)).toBe(0);
  });

  it("caps distributed guessing against one account (20 failures from any IPs)", () => {
    for (let i = 0; i < 21; i++) recordLoginFailure("exam", "b@example.com", `10.1.0.${i}`, 0);
    expect(loginRetryAfter("exam", "b@example.com", "10.9.9.9", 0)).toBe(MIN);
  });

  it("limits one IP across many accounts (30 failures)", () => {
    for (let i = 0; i < 31; i++) recordLoginFailure("staff", `user${i}@example.com`, "10.2.0.1", 0);
    expect(loginRetryAfter("staff", "fresh@example.com", "10.2.0.1", 0)).toBe(MIN);
    expect(loginRetryAfter("staff", "fresh@example.com", "10.2.0.2", 0)).toBe(0);
  });

  it("a success clears the account's counters", () => {
    fail(6, "c@example.com", "10.3.0.1", 0);
    recordLoginSuccess("staff", "c@example.com", "10.3.0.1");
    expect(loginRetryAfter("staff", "c@example.com", "10.3.0.1", 0)).toBe(0);
  });

  it("without a client IP only the account keys apply", () => {
    fail(6, "d@example.com", null, 0);
    expect(loginRetryAfter("staff", "d@example.com", null, 0)).toBeGreaterThan(0);
  });
});

describe("Content-Security-Policy", () => {
  it("allows only nonce'd scripts in production, with no eval and no inline scripts", () => {
    const csp = contentSecurityPolicy({ nonce: "abc", dev: false, upgradeInsecure: true });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).toContain("connect-src 'self';");
  });

  it("adds only what development needs", () => {
    const csp = contentSecurityPolicy({ nonce: "abc", dev: true, upgradeInsecure: false });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("nonces are fresh and long enough", () => {
    const a = newNonce();
    expect(Buffer.from(a, "base64").length).toBe(16);
    expect(newNonce()).not.toBe(a);
  });
});
