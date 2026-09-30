import "server-only";
import { UserStatus, type Role } from "@/generated/prisma/enums";
import { db } from "../db";
import { env } from "../env";
import { generateSessionToken, hashSessionToken } from "./tokens";

/** The authenticated user as exposed to the rest of the app (never includes the password hash). */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function createSession(userId: string, meta: RequestMeta = {}) {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + env().SESSION_TTL_HOURS * 60 * 60 * 1000);
  await db.session.create({
    data: {
      tokenHash: hashSessionToken(token),
      userId,
      expiresAt,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    },
  });
  return { token, expiresAt };
}

/**
 * Resolve a cookie token to its user. Returns null for unknown, expired or disabled-account
 * sessions; expired rows are deleted on sight.
 */
export async function validateSessionToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: { select: { id: true, email: true, name: true, role: true, status: true } } },
  });
  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await db.session.deleteMany({ where: { id: session.id } });
    return null;
  }
  if (session.user.status !== UserStatus.ACTIVE) return null;

  const { id, email, name, role } = session.user;
  return { id, email, name, role };
}

export async function invalidateSession(token: string) {
  await db.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
}

export async function invalidateAllUserSessions(userId: string) {
  await db.session.deleteMany({ where: { userId } });
}
