import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssessmentStatus, ExamCredentialStatus, Role, UserStatus } from "@/generated/prisma/enums";
import { EXAM_LOGIN_ERRORS, LOGIN_ERRORS, SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { db } from "@/server/db";
import { hashSessionToken } from "@/server/auth/tokens";
import { createAssessmentRow, createExamAccess, createUser, hoursFromNow, resetDatabase, TEST_EXAM_CODE, TEST_PASSWORD } from "./helpers";

// --- Next.js request APIs, backed by an in-memory cookie jar -------------------------------
interface StoredCookie {
  value: string;
  options: Record<string, unknown>;
}
const jar = new Map<string, StoredCookie>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options: Record<string, unknown> = {}) => jar.set(name, { value, options }),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "10.0.0.9" }),
}));

class RedirectSignal extends Error {
  constructor(public url: string) {
    super(`redirect:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

const { examLoginAction, loginAction, logoutAction } = await import("@/server/auth/actions");
const { getCurrentUser } = await import("@/server/auth/current-user");
const { requireRole } = await import("@/server/auth/guards");
const { requireAreaUser } = await import("@/server/auth/area");
const { validateSessionToken } = await import("@/server/auth/session");

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Runs a login action and returns where it redirected, or the returned form state. */
async function submit(action: typeof loginAction, fields: Record<string, string>) {
  try {
    const state = await action(null, form(fields));
    return { redirectedTo: null, state };
  } catch (err) {
    if (err instanceof RedirectSignal) return { redirectedTo: err.url, state: null };
    throw err;
  }
}
const submitLogin = (fields: Record<string, string>) => submit(loginAction, fields);
const submitExamLogin = (fields: Record<string, string>) => submit(examLoginAction, fields);

/** A learner assigned to an open assessment with an exam credential for TEST_EXAM_CODE. */
async function learnerWithExam(email = "learner1@example.com", opts: Parameters<typeof createAssessmentRow>[0] = {}) {
  const admin = await createUser({ role: Role.ADMIN, email: `admin-${crypto.randomUUID()}@example.com` });
  const learner = await createUser({ email, role: Role.LEARNER, name: "LEARNER person" });
  const assessment = await createAssessmentRow({ createdById: admin.id, ...opts });
  const access = await createExamAccess({ learnerId: learner.id, assessmentId: assessment.id, issuedById: admin.id });
  return { admin, learner, assessment, ...access };
}

const sessionCookie = () => jar.get(SESSION_COOKIE_NAME);

beforeEach(async () => {
  jar.clear();
  await resetDatabase();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => db.$disconnect());

describe("loginAction", () => {
  it.each([
    [Role.ADMIN, "admin@example.com", "/admin"],
    [Role.EXAMINER, "examiner@example.com", "/examiner"],
    [Role.REVIEWER, "reviewer@example.com", "/reviewer"],
  ] as const)("signs in a %s and redirects to %s", async (role, email, home) => {
    await createUser({ email, role });

    const { redirectedTo } = await submitLogin({ email, password: TEST_PASSWORD, role: "ignored" });

    expect(redirectedTo).toBe(home);
    expect(sessionCookie()).toBeDefined();
    expect(await db.session.count()).toBe(1);
  });

  it("sets an httpOnly, SameSite=Lax cookie holding only an opaque token", async () => {
    const user = await createUser({ email: "admin@example.com", role: Role.ADMIN });

    await submitLogin({ email: "admin@example.com", password: TEST_PASSWORD });

    const cookie = sessionCookie()!;
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: false });
    // The cookie is the random token; the database only has its hash.
    const session = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.tokenHash).toBe(hashSessionToken(cookie.value));
    expect(cookie.value).not.toContain("admin");
    expect(cookie.value).not.toContain(TEST_PASSWORD);
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Expiry matches the server-side session.
    expect((cookie.options.expires as Date).getTime()).toBe(session.expiresAt.getTime());
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("marks the cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await createUser({ email: "admin@example.com", role: Role.ADMIN });

    await submitLogin({ email: "admin@example.com", password: TEST_PASSWORD });

    expect(sessionCookie()!.options.secure).toBe(true);
  });

  it("rejects a wrong password with the generic message and no session", async () => {
    await createUser({ email: "admin@example.com", role: Role.ADMIN });

    const { redirectedTo, state } = await submitLogin({ email: "admin@example.com", password: "wrong-password" });

    expect(redirectedTo).toBeNull();
    expect(state).toEqual({ ok: false, error: LOGIN_ERRORS.invalid_credentials });
    expect(sessionCookie()).toBeUndefined();
    expect(await db.session.count()).toBe(0);
  });

  it("gives an unknown email exactly the same response as a wrong password", async () => {
    const { state } = await submitLogin({ email: "nobody@example.com", password: TEST_PASSWORD });

    expect(state).toEqual({ ok: false, error: LOGIN_ERRORS.invalid_credentials });
    expect(sessionCookie()).toBeUndefined();
  });

  it("refuses disabled accounts", async () => {
    await createUser({ email: "gone@example.com", role: Role.ADMIN, status: UserStatus.DISABLED });

    const { state } = await submitLogin({ email: "gone@example.com", password: TEST_PASSWORD });

    expect(state).toEqual({ ok: false, error: "Your account has been disabled. Please contact an administrator." });
    expect(sessionCookie()).toBeUndefined();
    expect(await db.session.count()).toBe(0);
  });

  it("validates input on the server", async () => {
    const { state } = await submitLogin({ email: "not-an-email", password: "" });

    expect(state).toMatchObject({ ok: false });
    expect(state && !state.ok && state.fieldErrors?.email).toBeTruthy();
    expect(state && !state.ok && state.fieldErrors?.password).toBeTruthy();
  });

  it("honours a safe next path the role may open", async () => {
    await createUser({ email: "admin@example.com", role: Role.ADMIN });

    const { redirectedTo } = await submitLogin({ email: "admin@example.com", password: TEST_PASSWORD, next: "/admin/users?page=2" });

    expect(redirectedTo).toBe("/admin/users?page=2");
  });

  it.each(["https://evil.example.com/admin", "//evil.example.com", "/learner", "/login"])(
    "ignores the unsafe or disallowed next %s",
    async (next) => {
      await createUser({ email: "admin@example.com", role: Role.ADMIN });

      const { redirectedTo } = await submitLogin({ email: "admin@example.com", password: TEST_PASSWORD, next });

      expect(redirectedTo).toBe("/admin");
    },
  );
});

describe("examLoginAction (learners)", () => {
  it("signs a learner in with email + exam password and redirects to /learner", async () => {
    const { credential } = await learnerWithExam();

    const { redirectedTo } = await submitExamLogin({ email: "Learner1@Example.com", code: " x7k-92p " });

    expect(redirectedTo).toBe("/learner");
    const cookie = sessionCookie()!;
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax" });
    expect(cookie.value).not.toContain(TEST_EXAM_CODE);
    const session = await db.session.findFirstOrThrow();
    expect(session.examCredentialId).toBe(credential.id);
    expect(session.tokenHash).toBe(hashSessionToken(cookie.value));
  });

  it.each([
    ["a wrong exam password", { email: "learner1@example.com", code: "AAAAAA" }],
    ["an unknown email", { email: "nobody@example.com", code: TEST_EXAM_CODE }],
  ])("rejects %s with the generic message", async (_label, fields) => {
    await learnerWithExam();

    const { state } = await submitExamLogin(fields);

    expect(state).toEqual({ ok: false, error: EXAM_LOGIN_ERRORS.invalid_credentials });
    expect(sessionCookie()).toBeUndefined();
  });

  it("rejects a staff account using the exam form", async () => {
    await createUser({ email: "admin@example.com", role: Role.ADMIN });
    const { state } = await submitExamLogin({ email: "admin@example.com", code: TEST_PASSWORD });
    expect(state).toEqual({ ok: false, error: EXAM_LOGIN_ERRORS.invalid_credentials });
  });

  it("rejects a learner using the staff password form", async () => {
    await learnerWithExam();
    const { state } = await submitLogin({ email: "learner1@example.com", password: TEST_EXAM_CODE });
    expect(state).toEqual({ ok: false, error: LOGIN_ERRORS.invalid_credentials });
  });

  it("explains an expired, not-yet-valid, disabled or closed case only to a holder of the right code", async () => {
    const { credential, learner, assessment } = await learnerWithExam();

    await db.examCredential.update({ where: { id: credential.id }, data: { validUntil: hoursFromNow(-0.5) } });
    expect((await submitExamLogin({ email: "learner1@example.com", code: TEST_EXAM_CODE })).state).toEqual({ ok: false, error: EXAM_LOGIN_ERRORS.expired });

    await db.examCredential.update({ where: { id: credential.id }, data: { validFrom: hoursFromNow(2), validUntil: hoursFromNow(4) } });
    const notYet = (await submitExamLogin({ email: "learner1@example.com", code: TEST_EXAM_CODE })).state;
    expect(notYet && !notYet.ok && notYet.error).toMatch(/^This exam password isn’t active yet\. It works from .+ IST\.$/);

    await db.examCredential.update({ where: { id: credential.id }, data: { validFrom: hoursFromNow(-1), validUntil: hoursFromNow(1) } });
    await db.assessment.update({ where: { id: assessment.id }, data: { status: AssessmentStatus.DRAFT } });
    expect((await submitExamLogin({ email: "learner1@example.com", code: TEST_EXAM_CODE })).state).toEqual({
      ok: false,
      error: EXAM_LOGIN_ERRORS.assessment_unavailable,
    });

    await db.assessment.update({ where: { id: assessment.id }, data: { status: AssessmentStatus.ACTIVE } });
    await db.user.update({ where: { id: learner.id }, data: { status: UserStatus.DISABLED } });
    expect((await submitExamLogin({ email: "learner1@example.com", code: TEST_EXAM_CODE })).state).toEqual({
      ok: false,
      error: "Your account has been disabled. Please contact an administrator.",
    });
    expect(await db.session.count()).toBe(0);
  });

  it("treats a revoked credential as wrong", async () => {
    const { credential } = await learnerWithExam();
    await db.examCredential.update({ where: { id: credential.id }, data: { status: ExamCredentialStatus.REVOKED } });

    const { state } = await submitExamLogin({ email: "learner1@example.com", code: TEST_EXAM_CODE });

    expect(state).toEqual({ ok: false, error: EXAM_LOGIN_ERRORS.invalid_credentials });
  });

  it("validates input on the server", async () => {
    const { state } = await submitExamLogin({ email: "", code: "" });
    expect(state && !state.ok && state.fieldErrors?.email).toBeTruthy();
    expect(state && !state.ok && state.fieldErrors?.code).toBeTruthy();
  });
});

describe("session lookup and area guards", () => {
  async function signIn(email: string, role: Role) {
    if (role === Role.LEARNER) {
      await learnerWithExam(email);
      await submitExamLogin({ email, code: TEST_EXAM_CODE });
      return;
    }
    await createUser({ email, role, name: `${role} person` });
    await submitLogin({ email, password: TEST_PASSWORD });
  }

  it("resolves the cookie to the signed-in user", async () => {
    await signIn("reviewer@example.com", Role.REVIEWER);

    await expect(getCurrentUser()).resolves.toMatchObject({ email: "reviewer@example.com", role: Role.REVIEWER });
  });

  it("sends anonymous visitors to /login", async () => {
    await expect(requireRole(Role.ADMIN)).rejects.toMatchObject({ url: "/login" });
    await expect(requireAreaUser(Role.LEARNER)).rejects.toMatchObject({ url: "/login" });
  });

  it("lets a learner with an exam session into /learner", async () => {
    await signIn("learner1@example.com", Role.LEARNER);

    await expect(requireAreaUser(Role.LEARNER)).resolves.toEqual({ name: "LEARNER person", email: "learner1@example.com", role: "learner" });
  });

  it("sends a stale or forged cookie to /login", async () => {
    jar.set(SESSION_COOKIE_NAME, { value: "forged-token", options: {} });
    await expect(requireRole(Role.ADMIN)).rejects.toMatchObject({ url: "/login" });
  });

  it("lets an admin into /admin and returns only name, email and UI role", async () => {
    await signIn("admin@example.com", Role.ADMIN);

    await expect(requireAreaUser(Role.ADMIN)).resolves.toEqual({ name: "ADMIN person", email: "admin@example.com", role: "admin" });
  });

  it.each([
    [Role.LEARNER, Role.ADMIN],
    [Role.LEARNER, Role.EXAMINER],
    [Role.LEARNER, Role.REVIEWER],
    [Role.EXAMINER, Role.ADMIN],
    [Role.EXAMINER, Role.REVIEWER],
    [Role.REVIEWER, Role.ADMIN],
    [Role.REVIEWER, Role.EXAMINER],
  ] as const)("blocks a %s from the %s area", async (actual, area) => {
    await signIn(`${actual.toLowerCase()}@example.com`, actual);

    await expect(requireAreaUser(area)).rejects.toMatchObject({ url: "/forbidden" });
  });

  it("stops accepting the session once the account is disabled", async () => {
    await signIn("learner1@example.com", Role.LEARNER);
    await db.user.updateMany({ data: { status: UserStatus.DISABLED } });

    await expect(requireAreaUser(Role.LEARNER)).rejects.toMatchObject({ url: "/login" });
  });
});

describe("logoutAction", () => {
  it("revokes the session, clears the cookie, audits and redirects to /login", async () => {
    const user = await createUser({ email: "admin@example.com", role: Role.ADMIN });
    await submitLogin({ email: "admin@example.com", password: TEST_PASSWORD });
    const token = sessionCookie()!.value;

    await expect(logoutAction()).rejects.toMatchObject({ url: "/login" });

    expect(sessionCookie()).toBeUndefined();
    expect(await db.session.count()).toBe(0);
    await expect(validateSessionToken(token)).resolves.toBeNull();
    const audit = await db.auditLog.findMany({ where: { actorId: user.id }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["auth.login_succeeded", "auth.logout"]);

    // Afterwards, protected areas send the visitor back to /login.
    await expect(requireAreaUser(Role.ADMIN)).rejects.toMatchObject({ url: "/login" });
  });

  it("is safe to call without a session", async () => {
    await expect(logoutAction()).rejects.toMatchObject({ url: "/login" });
  });
});
