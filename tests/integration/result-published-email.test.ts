import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { resolvePostLoginPath } from "@/lib/auth/rbac";
import { renderTemplate, SAMPLE_VALUES } from "@/lib/communication/templates";
import { NotFoundError } from "@/lib/errors";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { createSession, validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { emailProvider, TestEmailProvider } from "@/server/email";
import { deliverPendingEmails } from "@/server/email/outbox";
import { env } from "@/server/env";
import { createAssessment, publishAssessment, transitionAssessment } from "@/server/services/assessments";
import { terminateAttempt } from "@/server/services/attempt-termination";
import { startOrResumeAttempt, submitAttempt, type AttemptView, type ExamQuestion } from "@/server/services/attempts";
import { assignBatchToAssessment, assignExaminer, listCandidates } from "@/server/services/candidates";
import { createTemplate, dispatchAssessmentEvent, listCommunicationLog } from "@/server/services/communication";
import { finalizeEvaluation, saveEvaluation } from "@/server/services/evaluations";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { getMyResult } from "@/server/services/results";
import { assessmentInput, createActor, createReadyPaper, createBatchWithLearners, createCourse, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/*
 * D4 — the personalised Result Published email: one email per learner whose result becomes visible
 * when the admin publishes results, with only that learner's marks, queued in the outbox, delivered
 * by the worker (test provider — nothing reaches an inbox) and recorded in Communication History.
 */

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
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
const resultActions = await import("@/server/actions/results");
const mail = emailProvider() as TestEmailProvider;

beforeEach(async () => {
  jar.clear();
  mail.messages.length = 0;
  await resetDatabase();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => db.$disconnect());

const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);
const questionsOf = (v: AttemptView) => v.sections.flatMap((s) => s.items).filter((i): i is ExamQuestion => i.kind === "question");
const redirectOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof RedirectSignal ? e.url : Promise.reject(e)));
const signIn = async (user: { id: string }, options: { examCredentialId?: string } = {}) => jar.set(SESSION_COOKIE_NAME, (await createSession(user.id, {}, options)).token);
const resultLogs = () => db.communicationLog.findMany({ where: { event: "RESULT_PUBLISHED" }, orderBy: { recipientEmail: "asc" } });

const RESULT_TEMPLATE = {
  name: "Result Published",
  type: "RESULTS",
  trigger: "When results are published",
  subject: "Your result for {{assessment_name}} is published",
  body: "Hi {{learner_name}},\n\nYour result for {{assessment_name}} has been published.\n\nScore: {{marks_obtained}} / {{total_marks}}\nPercentage: {{percentage}}%\nResult: {{result_status}}\n\nYou can view your detailed result here:\n{{result_url}}\n\nRegards,\nAccredian",
  status: "ACTIVE",
  fromName: "Accredian Assessments",
  fromEmail: "assessments@example.com",
  replyTo: "",
};

/**
 * Max 10: Q1 MCQ (2), Q2 written (8); passing marks 5 unless overridden. Learners (one examiner):
 *   Asha 2 + 6 = 8 (80%, pass) · Bilal 0 + 2 = 2 (20%, fail) · Chen terminated · Dev never started.
 * Ends with the assessment at RESULT_READY (or EVALUATION with Bilal pending, when finalize = false).
 */
async function scenario(settings: Record<string, unknown> = {}, { finalize = true } = {}) {
  const admin = await createActor(Role.ADMIN);
  await createTemplate(admin, RESULT_TEMPLATE);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, { sections: [{ title: "Main", questions: [mcqSingle({ text: "Pick one", marks: 2, negativeMarks: 0 }), shortAnswer({ text: "Explain recall.", marks: 8 })] }] });
  const batch = await createBatchWithLearners(course.id, 4);
  const members = (await db.batchMember.findMany({ where: { batchId: batch.id }, orderBy: { user: { email: "asc" } }, select: { userId: true } })).map((m) => m.userId);
  const names = ["Asha Rao", "Bilal Khan", "Chen Li", "Dev Shah"];
  for (const [i, id] of members.entries()) await db.user.update({ where: { id }, data: { name: names[i], email: `${names[i].split(" ")[0].toLowerCase()}@learners.example.com` } });
  const startAt = hoursFromNow(1);
  const endAt = hoursFromNow(4);
  const assessment = await createAssessment(admin, assessmentInput(course.id, { name: "Churn Exam", type: "MIXED", paperId: paper.id, batchId: batch.id, startAt, endAt, durationMinutes: 60, passingMarks: 5, ...settings }));
  await publishAssessment(admin, assessment.id);
  await assignBatchToAssessment(admin, assessment.id, batch.id);
  const issued = await issueExamCredentials(admin, assessment.id);
  const examiner = await createActor(Role.EXAMINER);
  await assignExaminer(admin, assessment.id, (await listCandidates(admin, assessment.id)).map((c) => c.id), examiner.id);

  const T0 = at(startAt, 10);
  async function begin(learnerId: string) {
    const email = (await db.user.findUniqueOrThrow({ where: { id: learnerId } })).email;
    const cred = issued.find((i) => i.learner.email === email)!;
    const r = await authenticateExamCredential(email, cred.code, {}, T0);
    if (!r.ok) throw new Error(r.reason);
    const me = (await validateSessionToken(r.token, T0))!;
    const view = await startOrResumeAttempt(me, T0);
    return { me, attemptId: view.attempt.id, q: questionsOf(view), credentialId: (await db.examCredential.findFirstOrThrow({ where: { candidate: { learnerId } } })).id };
  }
  const asha = await begin(members[0]);
  await submitAttempt(asha.me, asha.attemptId, { responses: [{ assessmentQuestionId: asha.q[0].assessmentQuestionId, selectedOptionIds: [asha.q[0].options[1].id] }, { assessmentQuestionId: asha.q[1].assessmentQuestionId, textAnswer: "TP / (TP + FN)" }] }, at(T0, 20));
  const bilal = await begin(members[1]);
  await submitAttempt(bilal.me, bilal.attemptId, { responses: [{ assessmentQuestionId: bilal.q[0].assessmentQuestionId, selectedOptionIds: [bilal.q[0].options[0].id] }, { assessmentQuestionId: bilal.q[1].assessmentQuestionId, textAnswer: "Not sure." }] }, at(T0, 25));
  const chen = await begin(members[2]);
  await terminateAttempt(admin, { assessmentId: assessment.id, attemptId: chen.attemptId, reason: "Policy violation" }, at(T0, 5));

  await saveEvaluation(examiner, asha.attemptId, { marks: [{ assessmentQuestionId: asha.q[1].assessmentQuestionId, awardedMarks: 6 }] });
  await finalizeEvaluation(examiner, asha.attemptId);
  await saveEvaluation(examiner, bilal.attemptId, { marks: [{ assessmentQuestionId: bilal.q[1].assessmentQuestionId, awardedMarks: 2 }] });
  const afterEnd = at(endAt, 10);
  await transitionAssessment(admin, assessment.id, "EVALUATION", afterEnd);
  if (finalize) {
    await finalizeEvaluation(examiner, bilal.attemptId);
    await transitionAssessment(admin, assessment.id, "RESULT_READY", afterEnd);
  }
  return { admin, examiner, assessment, asha, bilal, chen, afterEnd };
}

/** The admin's real "Publish results" action. */
async function publishResults(s: Awaited<ReturnType<typeof scenario>>) {
  await signIn(s.admin);
  return resultActions.moveAssessmentAction(s.assessment.id, "PUBLISHED");
}

const resultUrl = (attemptId: string) => `${env().APP_URL.replace(/\/$/, "")}/login?next=${encodeURIComponent(`/learner/results/${attemptId}`)}`;

describe("Result Published email", () => {
  it("1–7/9/10/12/14/15: publishing queues one personal email per learner with a visible result; the worker delivers each to that learner only", async () => {
    const s = await scenario();
    expect(await publishResults(s)).toEqual({ ok: true });
    expect((await db.assessment.findUniqueOrThrow({ where: { id: s.assessment.id } })).status).toBe("PUBLISHED");

    // 12: one row per learner with a result — not Chen (terminated) or Dev (never started). 15: queued, not sent.
    const queued = await resultLogs();
    expect(queued.map((l) => [l.recipientEmail, l.status, l.dedupeKey])).toEqual([
      ["asha@learners.example.com", "PENDING", `RESULT_PUBLISHED:${s.asha.attemptId}`],
      ["bilal@learners.example.com", "PENDING", `RESULT_PUBLISHED:${s.bilal.attemptId}`],
    ]);
    expect(mail.messages).toHaveLength(0);

    expect(await deliverPendingEmails()).toMatchObject({ claimed: 2, notDelivered: 2 });
    const toAsha = mail.messages.filter((m) => m.to === "asha@learners.example.com");
    const toBilal = mail.messages.filter((m) => m.to === "bilal@learners.example.com");
    expect([toAsha.length, toBilal.length, mail.messages.length]).toEqual([1, 1, 2]);

    // 2–7/9: Asha's own details only.
    const a = toAsha[0];
    expect(a.subject).toBe("Your result for Churn Exam is published");
    expect(a.text).toBe(`Hi Asha,\n\nYour result for Churn Exam has been published.\n\nScore: 8 / 10\nPercentage: 80%\nResult: Pass\n\nYou can view your detailed result here:\n${resultUrl(s.asha.attemptId)}\n\nRegards,\nAccredian`);
    expect(toBilal[0].text).toContain("Hi Bilal,");
    expect(toBilal[0].text).toContain("Score: 2 / 10\nPercentage: 20%\nResult: Fail");
    // 10: nobody else's name, address, marks or result link.
    for (const other of ["Bilal", "bilal@", "Chen", "Dev", "Score: 2 /", s.bilal.attemptId, s.chen.attemptId]) {
      expect(a.text).not.toContain(other);
      expect(a.html).not.toContain(other);
      expect(a.subject).not.toContain(other);
    }
    for (const other of ["Asha", "asha@", "Score: 8 /", s.asha.attemptId]) expect(toBilal[0].text + toBilal[0].html).not.toContain(other);

    // 9: the link signs the learner in and lands on their own result — which another learner can't open.
    const next = new URL(resultUrl(s.asha.attemptId)).searchParams.get("next")!;
    expect(resolvePostLoginPath(Role.LEARNER, next)).toBe(`/learner/results/${s.asha.attemptId}`);
    await expect(getMyResult(s.bilal.me, s.asha.attemptId, at(s.afterEnd, 1))).rejects.toBeInstanceOf(NotFoundError);

    // 14/15: Communication History — recipient, assessment, type, time, honest status.
    const history = await listCommunicationLog(s.admin, { assessmentId: s.assessment.id });
    expect(history.filter((h) => h.event === "RESULT_PUBLISHED").map((h) => ({ to: h.recipientEmail, status: h.status, provider: h.provider, assessment: h.assessment?.name, template: h.template?.name }))).toEqual([
      { to: expect.stringMatching(/^(asha|bilal)@/), status: "NOT_DELIVERED", provider: "test", assessment: "Churn Exam", template: "Result Published" },
      { to: expect.stringMatching(/^(asha|bilal)@/), status: "NOT_DELIVERED", provider: "test", assessment: "Churn Exam", template: "Result Published" },
    ]);
    expect(history.every((h) => h.createdAt instanceof Date)).toBe(true);
    expect(await db.communicationLog.count({ where: { status: "SENT" } })).toBe(0);
  });

  it("8: no passing marks → no pass / fail in the email", async () => {
    const s = await scenario({ passingMarks: 0 });
    await publishResults(s);
    await deliverPendingEmails();
    const a = mail.messages.find((m) => m.to.startsWith("asha@"))!;
    expect(a.text).toContain("Score: 8 / 10\nPercentage: 80%\nResult: Not applicable");
    expect(a.text).not.toMatch(/\bPass\b|\bFail\b/);
  });

  it("11: the same result never produces a second automatic email — repeat publish, repeat or concurrent dispatch", async () => {
    const s = await scenario();
    await publishResults(s);
    expect(await resultLogs()).toHaveLength(2);
    // Publishing again is refused by the lifecycle; nothing new is queued.
    expect(await publishResults(s)).toMatchObject({ ok: false });
    // Even a repeated or concurrent dispatch of the event records nothing new.
    const again = await Promise.all([dispatchAssessmentEvent(s.assessment.id, "RESULT_PUBLISHED", s.admin.id), dispatchAssessmentEvent(s.assessment.id, "RESULT_PUBLISHED", s.admin.id)]);
    expect(again.map((r) => r.queued)).toEqual([0, 0]);
    expect(await resultLogs()).toHaveLength(2);
    await deliverPendingEmails();
    expect(mail.messages).toHaveLength(2);
  });

  it("13/20: a learner without a valid address gets a FAILED entry; a provider failure is retried; others and the publication are unaffected", async () => {
    const s = await scenario();
    await db.user.update({ where: { id: s.bilal.me.id }, data: { email: "bilal-at-nowhere" } });
    const send = mail.send.bind(mail);
    vi.spyOn(mail, "send").mockImplementation(async (m) => (m.to.startsWith("asha@") ? { status: "FAILED", error: "Mailbox unavailable" } : send(m)));
    expect(await publishResults(s)).toEqual({ ok: true });
    expect((await db.assessment.findUniqueOrThrow({ where: { id: s.assessment.id } })).status).toBe("PUBLISHED");

    let logs = await resultLogs();
    expect(logs.map((l) => [l.recipientEmail, l.status, l.error])).toEqual([
      ["asha@learners.example.com", "PENDING", null],
      ["bilal-at-nowhere", "FAILED", "The learner has no valid email address."],
    ]);
    expect(await deliverPendingEmails()).toMatchObject({ claimed: 1, retrying: 1 });
    logs = await resultLogs();
    // Not sent and not given up yet: queued again for a retry, with the reason recorded.
    expect(logs[0]).toMatchObject({ status: "PENDING", attempts: 1, error: "Mailbox unavailable" });
  });

  it("20: publication succeeds even if queuing the emails fails", async () => {
    const s = await scenario();
    vi.spyOn(db.communicationLog, "createMany").mockRejectedValueOnce(new Error("connection reset"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await publishResults(s)).toEqual({ ok: true });
    expect((await db.assessment.findUniqueOrThrow({ where: { id: s.assessment.id } })).status).toBe("PUBLISHED");
    expect(await resultLogs()).toHaveLength(0);
  });

  it("18: while evaluation is pending nothing is sent — results can't be published and the event finds no visible result", async () => {
    const s = await scenario({}, { finalize: false });
    expect(await dispatchAssessmentEvent(s.assessment.id, "RESULT_PUBLISHED", s.admin.id)).toMatchObject({ queued: 0 });
    expect(await publishResults(s)).toMatchObject({ ok: false });
    expect(await resultLogs()).toHaveLength(0);
  });

  it("16/17: examiners and learners can't publish results or trigger the email", async () => {
    const s = await scenario();
    await signIn(s.examiner);
    expect(await redirectOf(resultActions.moveAssessmentAction(s.assessment.id, "PUBLISHED"))).toBe("/forbidden");
    await signIn(s.asha.me, { examCredentialId: s.asha.credentialId });
    expect(await redirectOf(resultActions.moveAssessmentAction(s.assessment.id, "PUBLISHED"))).toBe("/forbidden");
    jar.clear();
    expect(await redirectOf(resultActions.moveAssessmentAction(s.assessment.id, "PUBLISHED"))).toBe("/login");
    expect(await resultLogs()).toHaveLength(0);
    expect((await db.assessment.findUniqueOrThrow({ where: { id: s.assessment.id } })).status).toBe("RESULT_READY");
  });

  it("19: templates keep working — the result variables are allowed and previewable; unknown variables are still refused", async () => {
    const admin = await createActor(Role.ADMIN);
    const t = await createTemplate(admin, RESULT_TEMPLATE);
    expect(renderTemplate(t, SAMPLE_VALUES).text).toContain("Score: 42 / 50\nPercentage: 84%\nResult: Pass");
    await expect(createTemplate(admin, { ...RESULT_TEMPLATE, name: "Bad", body: "{{someone_elses_marks}}" })).rejects.toThrow();
    // Other emails don't get result values: an unrelated template renders as before.
    expect(renderTemplate({ subject: "{{assessment_name}}", body: "Hi {{learner_name}}" }, { assessment_name: "X", learner_name: "Y" })).toMatchObject({ subject: "X", text: "Hi Y" });
  });
});
