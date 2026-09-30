import "server-only";
import { UserStatus } from "@/generated/prisma/enums";
import { AuditAction, recordAudit } from "../audit";
import { db } from "../db";
import { verifyAgainstDummy, verifyPassword } from "./password";
import { createSession, type RequestMeta, type SessionUser } from "./session";

export type LoginResult =
  | { ok: true; user: SessionUser; token: string; expiresAt: Date }
  | { ok: false; reason: "invalid_credentials" | "account_disabled" };

/**
 * Verify credentials and open a session. Unknown email and wrong password produce the same
 * result so the login form cannot be used to discover accounts.
 */
export async function login(email: string, password: string, meta: RequestMeta = {}): Promise<LoginResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await db.user.findUnique({ where: { email: normalizedEmail } });

  const passwordOk = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyAgainstDummy(password);

  if (!user || !passwordOk) {
    await recordAudit({
      actorId: user?.id ?? null,
      action: AuditAction.LOGIN_FAILED,
      entityType: "User",
      entityId: user?.id,
      metadata: { email: normalizedEmail, reason: "invalid_credentials" },
      ipAddress: meta.ipAddress,
    });
    return { ok: false, reason: "invalid_credentials" };
  }

  if (user.status !== UserStatus.ACTIVE) {
    await recordAudit({
      actorId: user.id,
      action: AuditAction.LOGIN_FAILED,
      entityType: "User",
      entityId: user.id,
      metadata: { email: normalizedEmail, reason: "account_disabled" },
      ipAddress: meta.ipAddress,
    });
    return { ok: false, reason: "account_disabled" };
  }

  const { token, expiresAt } = await createSession(user.id, meta);
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await recordAudit({
    actorId: user.id,
    action: AuditAction.LOGIN_SUCCEEDED,
    entityType: "User",
    entityId: user.id,
    ipAddress: meta.ipAddress,
  });

  return {
    ok: true,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    token,
    expiresAt,
  };
}
