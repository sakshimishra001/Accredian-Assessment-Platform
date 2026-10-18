import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { PasswordTokenPurpose, Role, UserStatus } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { setPasswordSchema, staffAccountSchema, STAFF_ROLES } from "@/lib/validation/staff";
import { AuditAction, recordAudit } from "../audit";
import { hashPassword } from "../auth/password";
import { invalidateAllUserSessions, type RequestMeta, type SessionUser } from "../auth/session";
import { generateSessionToken, hashSessionToken } from "../auth/tokens";
import { assertAdmin } from "../authz";
import { db, type DbTx } from "../db";
import { env } from "../env";

/*
 * Staff account lifecycle (administrators, examiners, reviewers). There are no shared or
 * administrator-chosen passwords: a new account — and an administrator-initiated reset — gets a
 * one-time link with which the person sets their own password. The link is shown once to the
 * administrator (no email service is connected yet); only its SHA-256 hash is stored, and it stops
 * working once used, when it expires, or when a newer link is issued. A reset also removes the old
 * password and signs the person out everywhere. Disabling an account ends its sessions at once.
 */

export const INVITE_LINK_HOURS = 72;
export const RESET_LINK_HOURS = 24;

const STAFF = STAFF_ROLES as readonly Role[];
const INVALID_LINK = "This link is invalid or has expired. Ask an administrator for a new one.";

export interface PasswordLink {
  /** The one-time URL; returned here only, never stored. */
  url: string;
  expiresAt: Date;
}

/** Replace any outstanding links of the user with a fresh one. */
async function issueLink(tx: DbTx, userId: string, purpose: PasswordTokenPurpose, createdById: string | null, now: Date): Promise<PasswordLink> {
  await tx.passwordToken.deleteMany({ where: { userId, usedAt: null } });
  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + (purpose === PasswordTokenPurpose.INVITE ? INVITE_LINK_HOURS : RESET_LINK_HOURS) * 3_600_000);
  await tx.passwordToken.create({ data: { userId, tokenHash: hashSessionToken(token), purpose, expiresAt, createdById } });
  return { url: `${env().APP_URL.replace(/\/$/, "")}/set-password?token=${token}`, expiresAt };
}

/** Staff accounts with what an administrator needs to manage them (never a hash or a token). */
export async function listStaff(actor: SessionUser, now: Date = new Date()) {
  assertAdmin(actor);
  const rows = await db.user.findMany({
    where: { role: { in: [...STAFF] } },
    orderBy: [{ role: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      status: true,
      lastLoginAt: true,
      createdAt: true,
      passwordHash: true,
      passwordTokens: { where: { usedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" }, take: 1, select: { purpose: true, expiresAt: true } },
    },
  });
  return rows.map(({ passwordHash, passwordTokens, ...u }) => ({
    ...u,
    hasPassword: !!passwordHash,
    pendingLink: passwordTokens[0] ?? null,
  }));
}

/** Create a staff account with no password and return its one-time set-password link. */
export async function createStaffAccount(actor: SessionUser, raw: unknown, now: Date = new Date()) {
  assertAdmin(actor);
  return createAccountWithInvite(raw, actor.id, now);
}

/**
 * The account + invitation itself. `createdById` is the administrator (null when bootstrapping the
 * first administrator from the command line, see scripts/create-admin.ts).
 */
export async function createAccountWithInvite(raw: unknown, createdById: string | null, now: Date = new Date()) {
  const parsed = staffAccountSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, "Please correct the highlighted fields.");
  const { name, email, role } = parsed.data;
  try {
    return await db.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { name, email, role, status: UserStatus.ACTIVE, passwordHash: null }, select: { id: true, name: true, email: true, role: true } });
      const link = await issueLink(tx, user.id, PasswordTokenPurpose.INVITE, createdById, now);
      await recordAudit({ actorId: createdById, action: AuditAction.STAFF_CREATED, entityType: "User", entityId: user.id, metadata: { email, role } }, tx);
      await recordAudit({ actorId: createdById, action: AuditAction.STAFF_PASSWORD_LINK_ISSUED, entityType: "User", entityId: user.id, metadata: { purpose: PasswordTokenPurpose.INVITE } }, tx);
      return { user, link };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ValidationError("An account with this email already exists.", { email: ["Email already in use"] });
    }
    throw err;
  }
}

async function loadStaff(tx: DbTx, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true, email: true } });
  if (!user || !STAFF.includes(user.role)) throw new NotFoundError("Staff account not found.");
  return user;
}

/**
 * Administrator-initiated password reset: the current password stops working, every session of the
 * account ends, and a new one-time link is returned. Not for one's own account (that would sign
 * the administrator out with no way back in until the link is used).
 */
export async function issuePasswordReset(actor: SessionUser, userId: string, now: Date = new Date()): Promise<PasswordLink> {
  assertAdmin(actor);
  if (userId === actor.id) throw new ConflictError("You can’t reset your own password here. Ask another administrator.");
  const link = await db.$transaction(async (tx) => {
    const user = await loadStaff(tx, userId);
    if (user.status !== UserStatus.ACTIVE) throw new ConflictError("Enable the account before sending a password link.");
    await tx.user.update({ where: { id: userId }, data: { passwordHash: null } });
    await tx.session.deleteMany({ where: { userId } });
    const link = await issueLink(tx, userId, PasswordTokenPurpose.RESET, actor.id, now);
    await recordAudit({ actorId: actor.id, action: AuditAction.STAFF_PASSWORD_LINK_ISSUED, entityType: "User", entityId: userId, metadata: { purpose: PasswordTokenPurpose.RESET } }, tx);
    return link;
  });
  return link;
}

/**
 * A new one-time invitation link for an account that never set a password (the old link is replaced).
 */
export async function reissueInvite(actor: SessionUser, userId: string, now: Date = new Date()): Promise<PasswordLink> {
  assertAdmin(actor);
  return db.$transaction(async (tx) => {
    const user = await loadStaff(tx, userId);
    if (user.status !== UserStatus.ACTIVE) throw new ConflictError("Enable the account before sending a password link.");
    const full = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
    if (full.passwordHash) throw new ConflictError("This person has already set a password. Use “Reset password” instead.");
    const link = await issueLink(tx, userId, PasswordTokenPurpose.INVITE, actor.id, now);
    await recordAudit({ actorId: actor.id, action: AuditAction.STAFF_PASSWORD_LINK_ISSUED, entityType: "User", entityId: userId, metadata: { purpose: PasswordTokenPurpose.INVITE } }, tx);
    return link;
  });
}

/**
 * Disable or re-enable a staff account. Disabling ends its sessions and voids its open links at once;
 * an administrator can't disable themselves or the last active administrator.
 */
export async function setStaffStatus(actor: SessionUser, userId: string, status: UserStatus) {
  assertAdmin(actor);
  if (status !== UserStatus.ACTIVE && status !== UserStatus.DISABLED) throw new ValidationError("Choose a valid status.");
  if (userId === actor.id && status === UserStatus.DISABLED) throw new ConflictError("You can’t disable your own account.");
  await db.$transaction(async (tx) => {
    const user = await loadStaff(tx, userId);
    if (user.status === status) return;
    if (status === UserStatus.DISABLED && user.role === Role.ADMIN) {
      const others = await tx.user.count({ where: { role: Role.ADMIN, status: UserStatus.ACTIVE, id: { not: userId } } });
      if (others === 0) throw new ConflictError("At least one administrator must stay active.");
    }
    await tx.user.update({ where: { id: userId }, data: { status } });
    if (status === UserStatus.DISABLED) {
      await tx.session.deleteMany({ where: { userId } });
      await tx.passwordToken.deleteMany({ where: { userId, usedAt: null } });
    }
    await recordAudit({ actorId: actor.id, action: AuditAction.USER_STATUS_CHANGED, entityType: "User", entityId: userId, metadata: { from: user.status, to: status } }, tx);
  });
}

/** Who a set-password link is for, if it is still usable (for the page's heading). */
export async function peekPasswordToken(token: string, now: Date = new Date()) {
  if (!token || token.length > 200) return null;
  const row = await db.passwordToken.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: { purpose: true, usedAt: true, expiresAt: true, user: { select: { name: true, email: true, role: true, status: true } } },
  });
  if (!row || row.usedAt || row.expiresAt <= now || row.user.status !== UserStatus.ACTIVE || !STAFF.includes(row.user.role)) return null;
  return { purpose: row.purpose, name: row.user.name, email: row.user.email };
}

/**
 * Set a password with a one-time link. The link is consumed atomically (a second use fails), other
 * links of the account are voided and every existing session ends.
 */
export async function setPasswordWithToken(raw: unknown, meta: RequestMeta = {}, now: Date = new Date()) {
  const parsed = setPasswordSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, "Please correct the highlighted fields.");
  const tokenHash = hashSessionToken(parsed.data.token);
  const row = await db.passwordToken.findUnique({ where: { tokenHash }, select: { id: true, userId: true, user: { select: { email: true } } } });
  if (!row) throw new ValidationError(INVALID_LINK);
  const local = row.user.email.split("@")[0].toLowerCase();
  if (local.length >= 4 && parsed.data.password.toLowerCase().includes(local)) {
    throw new ValidationError("Please correct the highlighted fields.", { password: ["Don’t use your email address in your password"] });
  }
  const passwordHash = await hashPassword(parsed.data.password);

  const userId = await db.$transaction(async (tx) => {
    const { count } = await tx.passwordToken.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: now }, user: { status: UserStatus.ACTIVE, role: { in: [...STAFF] } } },
      data: { usedAt: now },
    });
    if (count !== 1) throw new ValidationError(INVALID_LINK);
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
    await tx.passwordToken.deleteMany({ where: { userId: row.userId, usedAt: null } });
    await recordAudit({ actorId: row.userId, action: AuditAction.STAFF_PASSWORD_SET, entityType: "User", entityId: row.userId, ipAddress: meta.ipAddress }, tx);
    return row.userId;
  });
  await invalidateAllUserSessions(userId);
}
