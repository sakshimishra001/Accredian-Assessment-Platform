import { describe, expect, it } from "vitest";
import { loginSchema } from "@/lib/validation/auth";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "@/server/auth/password";
import { generateSessionToken, hashSessionToken } from "@/server/auth/tokens";

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("s3cret-pass");
    expect(hash).not.toContain("s3cret-pass");
    expect(await verifyPassword("s3cret-pass", hash)).toBe(true);
    expect(await verifyPassword("wrong-pass", hash)).toBe(false);
  });

  it("salts hashes", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("dummy verification always fails", async () => {
    expect(await verifyAgainstDummy("anything")).toBe(false);
  });
});

describe("session tokens", () => {
  it("are long, URL-safe and unique", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("hash deterministically and never equal the raw token", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toBe(token);
    expect(hashSessionToken(token)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("loginSchema", () => {
  it("normalises email", () => {
    const r = loginSchema.parse({ email: "  Admin@Example.COM ", password: "x" });
    expect(r.email).toBe("admin@example.com");
  });

  it("rejects missing or malformed fields", () => {
    expect(loginSchema.safeParse({ email: "", password: "x" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: "not-an-email", password: "x" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
  });
});
