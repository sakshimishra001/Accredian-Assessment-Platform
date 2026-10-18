import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { EXAM_LOGIN_ERRORS, LOGIN_ERRORS, SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { createSession, type SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { addPaperQuestion, addSection, createQuestionPaper } from "@/server/services/question-papers";
import { createAssessmentRow, createCourse, createExamAccess, createUser, hoursFromNow, resetDatabase, shortAnswer, TEST_EXAM_CODE, TEST_PASSWORD } from "./helpers";

/*
 * Security hardening phase 1, end to end against assessment_test: sign-in throttling (staff and
 * exam), constant exam-login work, upload request-size limits and the same-origin check on the
 * upload routes.
 */

// --- Next.js request APIs: cookie jar + a configurable client IP ----------------------------
const jar = new Map<string, string>();
let clientIp = "203.0.113.10";
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": clientIp }),
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
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// Count bcrypt work without changing it.
vi.mock("@/server/auth/password", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/auth/password")>();
  return { ...real, verifyPassword: vi.fn(real.verifyPassword), verifyAgainstDummy: vi.fn(real.verifyAgainstDummy) };
});

const password = await import("@/server/auth/password");
const { examLoginAction, loginAction } = await import("@/server/auth/actions");
const { EXAM_LOGIN_CHECKS, EXAM_LOGIN_MAX_CHECKS } = await import("@/server/auth/exam-login");
const materialsRoute = await import("@/app/api/files/materials/route");
const answerRoute = await import("@/app/api/attempts/[attemptId]/files/route");

beforeEach(async () => {
  jar.clear();
  clientIp = "203.0.113.10";
  vi.mocked(password.verifyPassword).mockClear();
  vi.mocked(password.verifyAgainstDummy).mockClear();
  await resetDatabase();
});
afterEach(() => vi.useRealTimers());
afterAll(() => db.$disconnect());

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const staffLogin = (email: string, pw: string) => loginAction(null, form({ email, password: pw })).catch((e: unknown) => (e instanceof RedirectSignal ? { redirected: e.url } : Promise.reject(e)));
const examLogin = (email: string, code: string) => examLoginAction(null, form({ email, code })).catch((e: unknown) => (e instanceof RedirectSignal ? { redirected: e.url } : Promise.reject(e)));
const hashChecks = () => vi.mocked(password.verifyPassword).mock.calls.length + vi.mocked(password.verifyAgainstDummy).mock.calls.length;
/** Only Date is faked, so bcrypt's async work keeps running normally. */
const travel = (ms: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
};

// ===========================================================================
describe("staff sign-in throttling", () => {
  it("pauses an account after repeated failures, with the same response as a wrong password, then lets it in after the pause", { timeout: 60_000 }, async () => {
    const admin = await createUser({ role: Role.ADMIN, email: "admin.sec@example.com" });
    for (let i = 0; i < 5; i++) expect(await staffLogin(admin.email, "wrong-password")).toEqual({ ok: false, error: LOGIN_ERRORS.invalid_credentials });

    // 6th failure starts the pause; now even the right password gets the generic answer.
    expect(await staffLogin(admin.email, "wrong-password")).toEqual({ ok: false, error: LOGIN_ERRORS.invalid_credentials });
    vi.mocked(password.verifyPassword).mockClear();
    vi.mocked(password.verifyAgainstDummy).mockClear();
    expect(await staffLogin(admin.email, TEST_PASSWORD)).toEqual({ ok: false, error: LOGIN_ERRORS.invalid_credentials });
    // The refused attempt still did one hash check (same cost as a real attempt) and never checked the real password.
    expect(password.verifyAgainstDummy).toHaveBeenCalledTimes(1);
    expect(password.verifyPassword).not.toHaveBeenCalled();
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(await db.auditLog.count({ where: { action: "auth.login_throttled" } })).toBe(1);

    // Another IP isn't affected by this IP's failures.
    clientIp = "198.51.100.7";
    expect(await staffLogin(admin.email, TEST_PASSWORD)).toEqual({ redirected: "/admin" });

    // Back on the first IP: after the 30-second pause the right password works and clears the counters.
    jar.clear();
    clientIp = "203.0.113.10";
    travel(31_000);
    expect(await staffLogin(admin.email, TEST_PASSWORD)).toEqual({ redirected: "/admin" });
  });

  it("gives an unknown email exactly the same responses, including when paused", { timeout: 60_000 }, async () => {
    await createUser({ role: Role.ADMIN, email: "real.admin@example.com" });
    const responses = { real: [] as unknown[], ghost: [] as unknown[] };
    for (let i = 0; i < 7; i++) {
      responses.real.push(await staffLogin("real.admin@example.com", "nope-nope"));
      responses.ghost.push(await staffLogin("ghost@example.com", "nope-nope"));
    }
    expect(responses.ghost).toEqual(responses.real);
    expect(new Set(responses.real.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("limits one IP trying many accounts", async () => {
    await createUser({ role: Role.ADMIN, email: "target@example.com" });
    for (let i = 0; i < 31; i++) await staffLogin(`nobody${i}@example.com`, "nope-nope");
    expect(await staffLogin("target@example.com", TEST_PASSWORD)).toEqual({ ok: false, error: LOGIN_ERRORS.invalid_credentials });
    clientIp = "198.51.100.99";
    expect(await staffLogin("target@example.com", TEST_PASSWORD)).toEqual({ redirected: "/admin" });
  }, 120_000); // 32 sign-ins, each with a deliberate bcrypt check
});

// ===========================================================================
describe("exam sign-in", () => {
  async function learnerWithAccess(n = 1) {
    const admin = await createUser({ role: Role.ADMIN });
    const learner = await createUser({ role: Role.LEARNER, email: "lina.sec@example.com" });
    const assessments = [];
    for (let i = 0; i < n; i++) {
      const a = await createAssessmentRow({ createdById: admin.id });
      await createExamAccess({ learnerId: learner.id, assessmentId: a.id, issuedById: admin.id, code: i === 0 ? TEST_EXAM_CODE : `OTHER${i}` });
      assessments.push(a);
    }
    return { learner, assessments };
  }

  const work = async (email: string, code: string) => {
    vi.mocked(password.verifyPassword).mockClear();
    vi.mocked(password.verifyAgainstDummy).mockClear();
    const res = await examLogin(email, code);
    return { res, checks: hashChecks() };
  };
  /** An extra credential for `learnerId` on a fresh assessment with the given window. */
  async function extraCredential(learnerId: string, issuedById: string, code: string, window: { startAt: Date; endAt: Date }, published = false) {
    const a = await createAssessmentRow({ createdById: issuedById, ...window });
    if (published) await db.assessment.update({ where: { id: a.id }, data: { publishedAt: new Date() } });
    await createExamAccess({ learnerId, assessmentId: a.id, issuedById, code });
  }
  const NOW = () => ({ startAt: hoursFromNow(-1), endAt: hoursFromNow(1) });
  const PAST = () => ({ startAt: hoursFromNow(-48), endAt: hoursFromNow(-47) });
  const SOON = () => ({ startAt: hoursFromNow(2), endAt: hoursFromNow(3) });

  it("does exactly the same bcrypt work whether or not the email exists (expired passwords don't add work)", { timeout: 60_000 }, async () => {
    const { learner, assessments } = await learnerWithAccess();
    const adminId = assessments[0].createdById;
    for (let i = 0; i < 3; i++) await extraCredential(learner.id, adminId, `OLD00${i}`, PAST());
    expect((await work("lina.sec@example.com", "WRONG1")).checks).toBe(EXAM_LOGIN_CHECKS);
    expect((await work("ghost.learner@example.com", "WRONG1")).checks).toBe(EXAM_LOGIN_CHECKS);
    const ok = await work("lina.sec@example.com", TEST_EXAM_CODE);
    expect(ok.res).toEqual({ redirected: "/learner" });
    expect(ok.checks).toBe(EXAM_LOGIN_CHECKS);
  });

  it("checks every usable password: a newly issued upcoming one is still found next to current and results-only ones", { timeout: 60_000 }, async () => {
    const admin = await createUser({ role: Role.ADMIN });
    const learner = await createUser({ role: Role.LEARNER, email: "lina.sec@example.com" });
    await extraCredential(learner.id, admin.id, "CURR01", NOW());
    await extraCredential(learner.id, admin.id, "CURR02", NOW());
    await extraCredential(learner.id, admin.id, "PAST01", PAST(), true);
    await extraCredential(learner.id, admin.id, TEST_EXAM_CODE, SOON());

    const { res, checks } = await work(learner.email, TEST_EXAM_CODE);
    expect((res as { error: string }).error).toContain(EXAM_LOGIN_ERRORS.not_yet_valid);
    expect(checks).toBe(4);
  });

  it("finds the oldest of several current passwords, and caps the work for a learner with very many", { timeout: 90_000 }, async () => {
    const admin = await createUser({ role: Role.ADMIN });
    const learner = await createUser({ role: Role.LEARNER, email: "lina.sec@example.com" });
    await extraCredential(learner.id, admin.id, TEST_EXAM_CODE, NOW());
    await extraCredential(learner.id, admin.id, "CURR02", NOW());
    await extraCredential(learner.id, admin.id, "CURR03", NOW());
    const ok = await work(learner.email, TEST_EXAM_CODE);
    expect(ok.res).toEqual({ redirected: "/learner" });
    expect(ok.checks).toBe(3);

    for (let i = 0; i < 4; i++) await extraCredential(learner.id, admin.id, `MORE0${i}`, SOON());
    expect((await work(learner.email, "WRONG1")).checks).toBe(EXAM_LOGIN_MAX_CHECKS);
  });

  it("pauses repeated wrong exam passwords with the generic message, then signs in after the pause", { timeout: 60_000 }, async () => {
    const { learner } = await learnerWithAccess();
    for (let i = 0; i < 6; i++) expect(await examLogin(learner.email, `BAD00${i}`)).toEqual({ ok: false, error: EXAM_LOGIN_ERRORS.invalid_credentials });
    expect(await examLogin(learner.email, TEST_EXAM_CODE)).toEqual({ ok: false, error: EXAM_LOGIN_ERRORS.invalid_credentials });
    expect(await examLogin("ghost.learner@example.com", "BAD999")).toEqual({ ok: false, error: EXAM_LOGIN_ERRORS.invalid_credentials });
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);

    travel(31_000);
    expect(await examLogin(learner.email, TEST_EXAM_CODE)).toEqual({ redirected: "/learner" });
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(true);
  });
});

// ===========================================================================
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001", "hex");
const SAME_ORIGIN = { origin: "http://localhost", "sec-fetch-site": "same-origin" };

async function adminWithDraftQuestion() {
  const u = await createUser({ role: Role.ADMIN });
  const admin: SessionUser = { id: u.id, email: u.email, name: u.name, role: u.role };
  const course = await createCourse();
  const paper = await createQuestionPaper(admin, { name: "Security paper", courseId: course.id });
  const s = await addSection(admin, paper.id, { title: "A" });
  const q = await addPaperQuestion(admin, s.id, shortAnswer());
  jar.set(SESSION_COOKIE_NAME, (await createSession(u.id)).token);
  return { paperQuestionId: q.id };
}

function multipart(fields: Record<string, string>, file: { name: string; data: Buffer }, headers: Record<string, string> = SAME_ORIGIN) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.set("file", new File([new Uint8Array(file.data)], file.name));
  return new Request("http://localhost/api/files/materials", { method: "POST", body: fd, headers });
}

/** A body that streams `total` bytes in 1 MB chunks (no Content-Length), counting what was pulled. */
function streamingRequest(total: number, headers: Record<string, string>) {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      const chunk = new Uint8Array(Math.min(1024 * 1024, total - sent));
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const request = new Request("http://localhost/api/files/materials", { method: "POST", body, headers: { "content-type": "multipart/form-data; boundary=x", ...headers }, duplex: "half" } as RequestInit);
  return { request, sent: () => sent };
}

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as { ok: boolean; error?: string } });

describe("upload request-size protection", () => {
  it("accepts a valid upload without a Content-Length header (streamed)", async () => {
    const { paperQuestionId } = await adminWithDraftQuestion();
    const res = await json(await materialsRoute.POST(multipart({ paperQuestionId }, { name: "chart.png", data: PNG })));
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    expect(await db.storedFile.count()).toBe(1);
  });

  it("refuses a declared Content-Length above the limit before reading the body", async () => {
    await adminWithDraftQuestion();
    const { request, sent } = streamingRequest(5 * 1024 * 1024, { ...SAME_ORIGIN, "content-length": String(500 * 1024 * 1024) });
    expect(await json(await materialsRoute.POST(request))).toMatchObject({ status: 413, body: { error: expect.stringMatching(/too large/) } });
    expect(sent()).toBeLessThanOrEqual(1024 * 1024);
  });

  it("cuts off an oversized body without (or with a false) Content-Length, never buffering past the limit", async () => {
    await adminWithDraftQuestion();
    const huge = 200 * 1024 * 1024;
    const noLength = streamingRequest(huge, SAME_ORIGIN);
    expect((await materialsRoute.POST(noLength.request)).status).toBe(413);
    expect(noLength.sent()).toBeLessThan(30 * 1024 * 1024);

    const lying = streamingRequest(huge, { ...SAME_ORIGIN, "content-length": "1000" });
    expect((await materialsRoute.POST(lying.request)).status).toBe(413);
    expect(lying.sent()).toBeLessThan(30 * 1024 * 1024);
    expect(await db.storedFile.count()).toBe(0);
  });

  it("still applies the per-file size limit inside an acceptable request", async () => {
    const admin = await createUser({ role: Role.ADMIN });
    const learner = await createUser({ role: Role.LEARNER });
    const assessment = await createAssessmentRow({ createdById: admin.id });
    const { credential } = await createExamAccess({ learnerId: learner.id, assessmentId: assessment.id, issuedById: admin.id });
    jar.set(SESSION_COOKIE_NAME, (await createSession(learner.id, {}, { examCredentialId: credential.id })).token);
    // The learner route caps the request at the platform maximum (50 MB) before parsing…
    const { request } = streamingRequest(5 * 1024 * 1024, { ...SAME_ORIGIN, "content-length": String(60 * 1024 * 1024) });
    expect((await answerRoute.POST(request, { params: Promise.resolve({ attemptId: "any" }) })).status).toBe(413);
  });

  it("rejects malformed or non-multipart uploads", async () => {
    await adminWithDraftQuestion();
    const notMultipart = new Request("http://localhost/api/files/materials", { method: "POST", body: "{}", headers: { ...SAME_ORIGIN, "content-type": "application/json" } });
    expect((await materialsRoute.POST(notMultipart)).status).toBe(415);
    const garbage = new Request("http://localhost/api/files/materials", { method: "POST", body: "not really multipart", headers: { ...SAME_ORIGIN, "content-type": "multipart/form-data; boundary=zzz" } });
    expect(await json(await materialsRoute.POST(garbage))).toMatchObject({ status: 400 });
    const noFile = new Request("http://localhost/api/files/materials", { method: "POST", body: form({ paperQuestionId: "x" }), headers: SAME_ORIGIN });
    expect(await json(await materialsRoute.POST(noFile))).toMatchObject({ status: 400, body: { error: "Choose a file to upload." } });
  });
});

describe("same-origin protection for upload routes", () => {
  it("accepts same-origin uploads", async () => {
    const { paperQuestionId } = await adminWithDraftQuestion();
    expect((await materialsRoute.POST(multipart({ paperQuestionId }, { name: "a.png", data: PNG }, { origin: "http://localhost" }))).status).toBe(200);
    expect((await materialsRoute.POST(multipart({ paperQuestionId }, { name: "b.png", data: PNG }, { "sec-fetch-site": "same-origin" }))).status).toBe(200);
    // The configured public address (APP_URL) is an allowed origin too.
    expect((await materialsRoute.POST(multipart({ paperQuestionId }, { name: "c.png", data: PNG }, { origin: "http://localhost:3000" }))).status).toBe(200);
  });

  it("refuses cross-site, same-site and header-less requests before reading them", async () => {
    const { paperQuestionId } = await adminWithDraftQuestion();
    const cases: Record<string, string>[] = [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site", origin: "http://other.localhost" },
      { origin: "null" },
      {},
    ];
    for (const headers of cases) {
      expect(await json(await materialsRoute.POST(multipart({ paperQuestionId }, { name: "x.png", data: PNG }, headers)))).toEqual({ status: 403, body: { ok: false, error: "Cross-site request refused." } });
    }
    expect(await db.storedFile.count()).toBe(0);
  });
});
