import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role, UserStatus } from "@/generated/prisma/enums";
import { AuditAction } from "@/server/audit";
import { login } from "@/server/auth/service";
import {
  createSession,
  invalidateAllUserSessions,
  invalidateSession,
  validateSessionToken,
} from "@/server/auth/session";
import { hashSessionToken } from "@/server/auth/tokens";
import { db } from "@/server/db";
import { createAssessmentRow, createExamAccess, createUser, resetDatabase, TEST_PASSWORD } from "./helpers";

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

describe("login", () => {
  it("opens a session for valid credentials and records the event", async () => {
    const user = await createUser({ email: "admin@example.com", role: Role.ADMIN });

    const result = await login("admin@example.com", TEST_PASSWORD, { ipAddress: "10.0.0.1", userAgent: "vitest" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user).toEqual({ id: user.id, email: user.email, name: user.name, role: Role.ADMIN });
    expect(result.user).not.toHaveProperty("passwordHash");

    const session = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.tokenHash).toBe(hashSessionToken(result.token));
    expect(session.tokenHash).not.toBe(result.token);
    expect(session.ipAddress).toBe("10.0.0.1");

    const refreshed = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.lastLoginAt).not.toBeNull();

    const audit = await db.auditLog.findMany({ where: { actorId: user.id } });
    expect(audit.map((a) => a.action)).toEqual([AuditAction.LOGIN_SUCCEEDED]);
  });

  it.each([Role.ADMIN, Role.EXAMINER, Role.REVIEWER])("signs in a %s with its role", async (role) => {
    const user = await createUser({ role });

    const result = await login(user.email, TEST_PASSWORD);

    expect(result).toMatchObject({ ok: true, user: { id: user.id, role } });
  });

  it("never signs in a learner with a password — not even a legacy stored hash", async () => {
    await createUser({ email: "learner@example.com", role: Role.LEARNER });
    await createUser({ email: "legacy@example.com", role: Role.LEARNER, withPassword: true });

    await expect(login("learner@example.com", TEST_PASSWORD)).resolves.toEqual({ ok: false, reason: "invalid_credentials" });
    await expect(login("legacy@example.com", TEST_PASSWORD)).resolves.toEqual({ ok: false, reason: "invalid_credentials" });
    expect(await db.session.count()).toBe(0);
  });

  it("stores learners without a password hash", async () => {
    const learner = await createUser({ role: Role.LEARNER });
    expect(learner.passwordHash).toBeNull();
  });

  it("treats email case-insensitively", async () => {
    await createUser({ email: "examiner@example.com", role: Role.EXAMINER });
    const result = await login("  Examiner@EXAMPLE.com ", TEST_PASSWORD);
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong password without creating a session", async () => {
    const user = await createUser({ email: "admin@example.com", role: Role.ADMIN });

    const result = await login("admin@example.com", "wrong-password");

    expect(result).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(await db.session.count()).toBe(0);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: AuditAction.LOGIN_FAILED } });
    expect(audit.actorId).toBe(user.id);
  });

  it("gives an unknown email the same response as a wrong password", async () => {
    const result = await login("nobody@example.com", TEST_PASSWORD);

    expect(result).toEqual({ ok: false, reason: "invalid_credentials" });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: AuditAction.LOGIN_FAILED } });
    expect(audit.actorId).toBeNull();
    expect(audit.metadata).toMatchObject({ email: "nobody@example.com" });
  });

  it("blocks disabled accounts even with the right password", async () => {
    await createUser({ email: "gone@example.com", role: Role.ADMIN, status: UserStatus.DISABLED });

    const result = await login("gone@example.com", TEST_PASSWORD);

    expect(result).toEqual({ ok: false, reason: "account_disabled" });
    expect(await db.session.count()).toBe(0);
  });
});

describe("sessions", () => {
  it("resolves a valid token to the user and role", async () => {
    const user = await createUser({ role: Role.EXAMINER });
    const { token, expiresAt } = await createSession(user.id);

    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    await expect(validateSessionToken(token)).resolves.toEqual({
      id: user.id,
      email: user.email,
      name: user.name,
      role: Role.EXAMINER,
    });
  });

  it("returns null for missing or unknown tokens", async () => {
    await expect(validateSessionToken(undefined)).resolves.toBeNull();
    await expect(validateSessionToken("not-a-real-token")).resolves.toBeNull();
  });

  it("rejects and deletes expired sessions", async () => {
    const user = await createUser({ role: Role.ADMIN });
    const { token } = await createSession(user.id);
    await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(validateSessionToken(token)).resolves.toBeNull();
    expect(await db.session.count()).toBe(0);
  });

  it("stops working when the account is disabled", async () => {
    const user = await createUser({ role: Role.ADMIN });
    const { token } = await createSession(user.id);
    await db.user.update({ where: { id: user.id }, data: { status: UserStatus.DISABLED } });

    await expect(validateSessionToken(token)).resolves.toBeNull();
  });

  it("is revoked by logout", async () => {
    const user = await createUser({ role: Role.ADMIN });
    const { token } = await createSession(user.id);
    const { token: other } = await createSession(user.id);

    await invalidateSession(token);

    await expect(validateSessionToken(token)).resolves.toBeNull();
    await expect(validateSessionToken(other)).resolves.not.toBeNull();
  });

  it("can revoke every session for a user", async () => {
    const user = await createUser({ role: Role.ADMIN });
    const a = await createSession(user.id);
    const b = await createSession(user.id);

    await invalidateAllUserSessions(user.id);

    await expect(validateSessionToken(a.token)).resolves.toBeNull();
    await expect(validateSessionToken(b.token)).resolves.toBeNull();
  });

  it("rejects a learner session that wasn't opened with an exam credential", async () => {
    const learner = await createUser({ role: Role.LEARNER });
    const { token } = await createSession(learner.id);

    await expect(validateSessionToken(token)).resolves.toBeNull();
  });

  it("scopes a learner session to the credential's assessment and ends it when the credential is revoked", async () => {
    const admin = await createUser({ role: Role.ADMIN });
    const learner = await createUser({ role: Role.LEARNER });
    const assessment = await createAssessmentRow({ createdById: admin.id });
    const { credential } = await createExamAccess({ learnerId: learner.id, assessmentId: assessment.id, issuedById: admin.id });
    const { token } = await createSession(learner.id, {}, { examCredentialId: credential.id });

    await expect(validateSessionToken(token)).resolves.toMatchObject({ id: learner.id, role: Role.LEARNER, assessmentId: assessment.id });

    await db.examCredential.update({ where: { id: credential.id }, data: { status: "REVOKED" } });
    await expect(validateSessionToken(token)).resolves.toBeNull();
  });
});
