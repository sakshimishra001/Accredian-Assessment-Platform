import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { env } from "../env";
import { validateSessionToken, type RequestMeta, type SessionUser } from "./session";

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE_NAME)?.value;
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE_NAME);
}

/** The signed-in user for this request, or null. Deduplicated per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  return validateSessionToken(await readSessionToken());
});

/**
 * Client IP and user agent for throttling and audit. The IP comes from X-Forwarded-For (first hop)
 * only when TRUST_PROXY is set — i.e. a reverse proxy in front of the app sets that header itself.
 * Otherwise a client could forge it, so no IP is recorded (and only per-account throttling applies).
 */
export async function getRequestMeta(): Promise<RequestMeta> {
  const h = await headers();
  const forwarded = env().TRUST_PROXY ? h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") : null;
  return {
    ipAddress: forwarded || null,
    userAgent: h.get("user-agent"),
  };
}
