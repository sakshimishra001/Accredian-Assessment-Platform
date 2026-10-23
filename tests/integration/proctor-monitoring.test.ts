import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { forAssessment, validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { createAssessment, publishAssessmentForBatch } from "@/server/services/assessments";
import { recordProctoringEvent, startOrResumeAttempt, submitAttempt } from "@/server/services/attempts";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { assignProctor, unassignProctor } from "@/server/services/proctor-assignments";
import { getProctorAttempt, getProctorMonitoring, listProctorAssessments } from "@/server/services/proctor-monitoring";
import { assessmentInput, createActor, createBatchWithLearners, createCourse, createReadyPaper, hoursFromNow, resetDatabase } from "./helpers";

/* Proctor dashboard, phase 2: read-only monitoring against PostgreSQL. */

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);
let n = 0;
const incident = () => `incident-${++n}-${crypto.randomUUID().slice(0, 8)}`;

/** Two proctored assessments (A and B), each with running attempts; a proctor assigned to A only. */
async function world() {
  const admin = await createActor(Role.ADMIN);
  const proctor = await createActor(Role.REVIEWER);
  const otherProctor = await createActor(Role.REVIEWER);
  const examiner = await createActor(Role.EXAMINER);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id);
  const startAt = hoursFromNow(1);
  const T = at(startAt, 5);
  async function exam(name: string, learners: number) {
    const batch = await createBatchWithLearners(course.id, learners);
    const a = await createAssessment(
      admin,
      assessmentInput(course.id, { name, paperId: paper.id, batchId: batch.id, startAt, endAt: at(startAt, 180), durationMinutes: 60, timingMode: "FULL_DURATION", proctoringEnabled: true, focusMonitoringEnabled: true, fullscreenEnabled: true, clipboardMonitoringEnabled: true, focusMaxViolations: 10 }),
    );
    await publishAssessmentForBatch(admin, a.id);
    const issued = (await issueExamCredentials(admin, a.id)).sort((x, y) => x.learner.name.localeCompare(y.learner.name));
    const sessions = [];
    for (const c of issued) {
      const r = await authenticateExamCredential(c.learner.email, c.code, {}, T);
      const user = (await validateSessionToken(r.ok ? r.token : null, T))!;
      const view = await startOrResumeAttempt(forAssessment(user, a.id), T);
      sessions.push({ user, attemptId: view.attempt.id });
    }
    return { a, sessions };
  }
  const A = await exam("Exam A", 2);
  const B = await exam("Exam B", 1);
  await assignProctor(admin, A.a.id, proctor.id);
  return { admin, proctor, otherProctor, examiner, A, B, T };
}

describe("proctor monitoring", () => {
  it("a proctor sees only assigned assessments; an administrator sees all; others are refused", async () => {
    const w = await world();
    expect((await listProctorAssessments(w.proctor, w.T)).map((a) => a.id)).toEqual([w.A.a.id]);
    expect(await listProctorAssessments(w.otherProctor, w.T)).toEqual([]);
    expect((await listProctorAssessments(w.admin, w.T)).map((a) => a.id).sort()).toEqual([w.A.a.id, w.B.a.id].sort());
    await expect(listProctorAssessments(w.examiner, w.T)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("running attempts are scoped to the assessment; another assessment's id is \"not found\"", async () => {
    const w = await world();
    const m = await getProctorMonitoring(w.proctor, w.A.a.id, w.T);
    expect(m.attempts.map((t) => t.id).sort()).toEqual(w.A.sessions.map((s) => s.attemptId).sort());
    await expect(getProctorMonitoring(w.proctor, w.B.a.id, w.T)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProctorMonitoring(w.examiner, w.A.a.id, w.T)).rejects.toBeInstanceOf(ForbiddenError);
    // A submitted attempt leaves the running list.
    await submitAttempt(w.A.sessions[0].user, w.A.sessions[0].attemptId, { responses: [] }, at(w.T, 1));
    expect((await getProctorMonitoring(w.proctor, w.A.a.id, at(w.T, 2))).attempts.map((t) => t.id)).toEqual([w.A.sessions[1].attemptId]);
  });

  it("violation counts are grouped by event type from the event log, matching the server's counter", async () => {
    const w = await world();
    const s = w.A.sessions[0];
    const shared = incident();
    for (const [i, [eventType, id]] of ([
      ["FOCUS_LOST", shared],
      ["FULLSCREEN_EXIT", shared], // same departure: not counted again
      ["FULLSCREEN_EXIT", incident()],
      ["CLIPBOARD_COPY", incident()],
      ["CLIPBOARD_CUT", incident()],
      ["CLIPBOARD_PASTE", incident()],
    ] as const).entries()) {
      await recordProctoringEvent(s.user, s.attemptId, { eventType, incidentId: id }, at(w.T, i + 1));
    }
    const row = (await getProctorMonitoring(w.proctor, w.A.a.id, at(w.T, 8))).attempts.find((t) => t.id === s.attemptId)!;
    expect(row.violations).toEqual({ focus: 1, fullscreen: 1, clipboardCopy: 1, clipboardCut: 1, clipboardPaste: 1, clipboard: 3, other: 0, total: 5 });
    expect(row.counted).toBe(5);
  });

  it("the timeline shows only the authorized attempt's events; an attempt of another assessment is \"not found\"", async () => {
    const w = await world();
    const mine = w.A.sessions[0];
    const theirs = w.B.sessions[0];
    await recordProctoringEvent(mine.user, mine.attemptId, { eventType: "FOCUS_LOST", incidentId: incident() }, at(w.T, 1));
    await recordProctoringEvent(theirs.user, theirs.attemptId, { eventType: "CLIPBOARD_PASTE", incidentId: incident() }, at(w.T, 1));
    const r = await getProctorAttempt(w.proctor, w.A.a.id, mine.attemptId, at(w.T, 2));
    expect(r.events.map((e) => e.eventType)).toEqual(["FOCUS_LOST"]);
    await expect(getProctorAttempt(w.proctor, w.A.a.id, theirs.attemptId, at(w.T, 2))).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProctorAttempt(w.proctor, w.B.a.id, theirs.attemptId, at(w.T, 2))).rejects.toBeInstanceOf(NotFoundError);
    // Unassigned: access ends.
    await unassignProctor(w.admin, w.A.a.id, w.proctor.id);
    await expect(getProctorAttempt(w.proctor, w.A.a.id, mine.attemptId, at(w.T, 3))).rejects.toBeInstanceOf(NotFoundError);
  });
});
