import { createHash, randomBytes } from "node:crypto";

/** 256-bit random token, URL-safe. Sent to the browser in the session cookie only. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What we persist: a leaked database row cannot be replayed as a cookie. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
