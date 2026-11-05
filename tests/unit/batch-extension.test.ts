import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Production issue: a 180-minute batch-wide extension on a 4:00–4:30 assessment didn't keep learners
 * going after 4:30. The extension maths was right for attempts running when it was granted; learners
 * who started *after* the grant got the original window deadline (nothing recorded the batch
 * extension for them). These tests run the real deadline, auto-submit, save, submit, clock and
 * extension code against an in-memory stand-in for the database.
 */

type Row = Record<string, unknown>;
const assessments = new Map<string, Row & { id: string }>();
const attempts = new Map<string, Row & { id: string; assessmentId: string; learnerId: string; status: string }>();
const grants: Row[] = [];
const audits: Row[] = [];
const responses = new Map<string, Row>();
const questions = [{ id: "q1", assessmentId: "exam", snapshot: { type: "MCQ_SINGLE", text: "Pick", options: [{ id: "o1", text: "A" }, { id: "o2", text: "B" }] }, paperQuestion: null, responses: [] }];
const ANSWER = { responses: [{ assessmentQuestionId: "q1", selectedOptionIds: ["o1"], clientSeq: 1 }] };

const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (v && typeof v === "object" && !(v instanceof Date) && "in" in (v as Row)) return ((v as { in: unknown[] }).in ?? []).includes(row[k]);
    if (v && typeof v === "object" && !(v instanceof Date)) return true; // relation filters (candidate: { assessmentId }) — always satisfied here
    return row[k] === v;
  });
const view = (a: Row & { assessmentId: string }) => ({ ...a, assessment: assessments.get(a.assessmentId), _count: { responses: 0 } });

let queue: Promise<unknown> = Promise.resolve();
const fakeDb = {
  assessment: {
    findUnique: async ({ where }: { where: { id: string } }) => assessments.get(where.id) ?? null,
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => assessments.get(where.id)!,
    update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(assessments.get(where.id)!, data),
  },
  assessmentAttempt: {
    findMany: async ({ where }: { where: Row }) => [...attempts.values()].filter((a) => matches(a, where)).map(view),
    findFirst: async ({ where }: { where: Row }) => {
      const a = [...attempts.values()].find((x) => matches(x, where));
      return a ? view(a) : null;
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => view(attempts.get(where.id)!),
    count: async ({ where }: { where: Row }) => [...attempts.values()].filter((a) => matches(a, where)).length,
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const a = attempts.get(where.id as string);
      if (!a || !matches(a, where)) return { count: 0 };
      Object.assign(a, data);
      return { count: 1 };
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const a = attempts.get(where.id)!;
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && "increment" in (v as Row)) a[k] = (a[k] as number) + ((v as { increment: number }).increment);
        else a[k] = v;
      }
      return a;
    },
  },
  attemptTimeExtension: { create: async ({ data }: { data: Row }) => void grants.push(data) },
  auditLog: { create: async ({ data }: { data: Row }) => void audits.push(data) },
  assessmentQuestion: {
    findMany: async ({ where }: { where: { assessmentId: string; id?: { in: string[] } } }) => questions.filter((q) => q.assessmentId === where.assessmentId && (!where.id || where.id.in.includes(q.id))),
  },
  attemptResponse: {
    findMany: async () => [],
    findUnique: async () => null,
    upsert: async ({ create }: { create: Row }) => void responses.set(String(responses.size), create),
  },
  proctoringEvent: { create: async () => ({ id: "ev-1" }) },
  $transaction: <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const run = queue.then(() => fn(fakeDb));
    queue = run.catch(() => undefined);
    return run;
  },
};

vi.mock("@/server/db", () => ({ db: fakeDb }));
vi.mock("@/server/services/evaluation-status", () => ({ setInitialEvaluationStatus: async () => undefined }));
vi.stubEnv("DATABASE_URL", "postgresql://unit:unit@localhost:5432/unit_test");

const { effectiveDeadline, initialDeadline, getMyAttemptClock, saveResponses, submitAttempt, closeExpiredAttempts } = await import("@/server/services/attempts");
const { extendAttempts, extendAttempt } = await import("@/server/services/attempt-extension");
const { findOwnRunningAttempt } = await import("@/server/services/running-attempt");

// The production case, in UTC: window 16:00–16:30, 30-minute duration, WINDOW timing.
const D = "2026-11-02";
const t = (hhmm: string) => new Date(`${D}T${hhmm}:00.000Z`);
const MIN = 60;
const admin = { id: "admin", email: "a@example.com", name: "Admin", role: "ADMIN" as const };
const learner = (id: string) => ({ id, email: `${id}@example.com`, name: id, role: "LEARNER" as const, sessionId: `s-${id}` });

function seed(timingMode: "WINDOW" | "FULL_DURATION" = "WINDOW") {
  assessments.clear();
  attempts.clear();
  grants.length = 0;
  audits.length = 0;
  responses.clear();
  assessments.set("exam", {
    id: "exam",
    status: "ACTIVE",
    timingMode,
    startAt: t("16:00"),
    endAt: t("16:30"),
    durationMinutes: 30,
    pausedAt: null,
    allowMarkForReview: true,
    batchExtensionSeconds: 0,
    proctoringEnabled: true,
    focusMonitoringEnabled: true,
    fullscreenEnabled: false,
    clipboardMonitoringEnabled: false,
    cameraRequired: false,
    faceDetectionEnabled: false,
    multipleFaceDetectionEnabled: false,
    faceMissingDetectionEnabled: false,
    cameraSnapshotsEnabled: false,
    screenMonitoringEnabled: false,
    focusMaxViolations: 10,
    focusViolationAction: "WARN",
  });
}

/** An attempt as startOrResumeAttempt stores it at `startedAt` (initialDeadline, with any batch extension already granted). */
function startAt(id: string, learnerId: string, startedAt: Date) {
  const initial = initialDeadline(startedAt, assessments.get("exam") as never);
  attempts.set(id, {
    id,
    assessmentId: "exam",
    learnerId,
    candidateId: `cand-${learnerId}`,
    status: "IN_PROGRESS",
    startedAt,
    deadlineAt: initial.deadlineAt,
    pausedSeconds: 0,
    extensionSeconds: initial.extensionSeconds,
    lockedAt: null,
    focusViolations: 0,
    focusLastIncidentId: null,
    lastActivityAt: startedAt,
  });
}
const deadlineOf = (id: string, now: Date) => {
  const a = attempts.get(id)!;
  return effectiveDeadline(a as never, assessments.get("exam") as never, now);
};

beforeEach(() => seed());

describe("1: 4:00–4:30 assessment + 180-minute batch extension", () => {
  it("extends those in progress AND learners who start later — the production failure", async () => {
    startAt("att-early", "early", t("16:10"));
    const r = await extendAttempts(admin, { assessmentId: "exam", scope: "BATCH", minutes: 180, reason: "Technical issue" }, t("16:19"));
    expect(r).toMatchObject({ extended: 1, skipped: 0, batchExtensionMinutes: 180 });
    expect(assessments.get("exam")!.batchExtensionSeconds).toBe(180 * MIN);

    // Started after the grant (16:22 and 16:25): previously their deadline stayed 16:30.
    startAt("att-late", "late", t("16:25"));
    expect(deadlineOf("att-early", t("16:20"))).toEqual(t("19:30"));
    expect(deadlineOf("att-late", t("16:25"))).toEqual(t("19:30"));
    // The bulk audit says the extension also applies to later starts.
    expect(audits.find((a) => a.action === "attempt.bulk_time_extended")?.metadata).toMatchObject({ scope: "BATCH", batchExtensionMinutes: 180, appliesToLaterStarts: true });
  });

  it("selected-learner and individual extensions still apply to those attempts only", async () => {
    startAt("att-a", "a", t("16:05"));
    await extendAttempts(admin, { assessmentId: "exam", scope: "SELECTED", attemptIds: ["att-a"], minutes: 60, reason: "Selected" }, t("16:10"));
    await extendAttempt(admin, { assessmentId: "exam", attemptId: "att-a", minutes: 15, reason: "One learner" }, t("16:12"));
    expect(assessments.get("exam")!.batchExtensionSeconds).toBe(0);
    startAt("att-b", "b", t("16:15"));
    expect(deadlineOf("att-a", t("16:15"))).toEqual(t("17:45"));
    expect(deadlineOf("att-b", t("16:15"))).toEqual(t("16:30"));
  });

  it("a batch extension granted before anyone starts covers everyone who starts", async () => {
    await extendAttempts(admin, { assessmentId: "exam", scope: "BATCH", minutes: 180, reason: "Planned" }, t("16:00"));
    startAt("att-x", "x", t("16:02"));
    expect(deadlineOf("att-x", t("16:02"))).toEqual(t("19:30"));
  });

  it("the batch total is capped like an attempt's (480 minutes)", async () => {
    await extendAttempts(admin, { assessmentId: "exam", scope: "BATCH", minutes: 180, reason: "One" }, t("16:00"));
    await extendAttempts(admin, { assessmentId: "exam", scope: "BATCH", minutes: 180, reason: "Two" }, t("16:01"));
    await expect(extendAttempts(admin, { assessmentId: "exam", scope: "BATCH", minutes: 180, reason: "Three" }, t("16:02"))).rejects.toThrow(/at most 480 minutes/);
    expect(assessments.get("exam")!.batchExtensionSeconds).toBe(360 * MIN);
  });
});

describe("2–5: the extended attempt is valid after 4:30 and closes at the extended deadline", () => {
  beforeEach(async () => {
    startAt("att", "lina", t("16:10"));
    await extendAttempts(admin, { assessmentId: "exam", scope: "BATCH", minutes: 180, reason: "Technical issue" }, t("16:19"));
    startAt("att-late", "leo", t("16:25"));
    // The window closes: the assessment itself is ENDED from 16:30.
    Object.assign(assessments.get("exam")!, { status: "ENDED" });
  });

  it("2: after 4:30 the attempt still runs — clock, saving, submitting (server-authoritative)", async () => {
    const after = t("16:45");
    expect(await getMyAttemptClock(learner("leo"), "att-late", after)).toMatchObject({ status: "IN_PROGRESS", remainingSeconds: (2 * 60 + 45) * MIN });
    await expect(saveResponses(learner("leo"), "att-late", ANSWER, after)).resolves.toMatchObject({ remainingSeconds: (2 * 60 + 45) * MIN });
    expect(attempts.get("att-late")!.status).toBe("IN_PROGRESS");
    await submitAttempt(learner("lina"), "att", { responses: [] }, t("17:00"));
    expect(attempts.get("att")).toMatchObject({ status: "SUBMITTED", submittedAt: t("17:00") });
  });

  it("3: at the extended deadline the attempt is no longer valid", async () => {
    await expect(saveResponses(learner("leo"), "att-late", ANSWER, t("19:30"))).rejects.toThrow(/Time is up/);
    expect(attempts.get("att-late")!.status).toBe("AUTO_SUBMITTED");
  });

  it("4: auto-submit (the sweep) uses the extended deadline — not 4:30", async () => {
    expect(await closeExpiredAttempts(t("16:31"), "exam")).toBe(0);
    expect(attempts.get("att-late")!.status).toBe("IN_PROGRESS");
    expect(await closeExpiredAttempts(t("19:30"), "exam")).toBe(2);
    expect(attempts.get("att-late")).toMatchObject({ status: "AUTO_SUBMITTED", submittedAt: t("19:30") });
  });

  it("5: resume / access checks (the exam's clock, presence and evidence) use the extended deadline, with the assessment ENDED", async () => {
    expect(await getMyAttemptClock(learner("leo"), "att-late", t("18:00"))).toMatchObject({ status: "IN_PROGRESS" });
    // Presence heartbeat / evidence: previously refused once the assessment was ENDED.
    await expect(findOwnRunningAttempt(learner("leo"), "att-late", t("18:00"))).resolves.toMatchObject({ id: "att-late" });
    await expect(findOwnRunningAttempt(learner("leo"), "att-late", t("19:30"))).rejects.toThrow(/not running/);
    // Ownership is unchanged: another learner's attempt stays "not found".
    await expect(findOwnRunningAttempt(learner("lina"), "att-late", t("18:00"))).rejects.toThrow(/not found/i);
  });
});

describe("6: assessments without extensions behave exactly as before", () => {
  it("WINDOW: the deadline is the window end; the attempt closes at 4:30", async () => {
    startAt("att", "lina", t("16:25"));
    expect(attempts.get("att")).toMatchObject({ deadlineAt: t("16:30"), extensionSeconds: 0 });
    expect(await getMyAttemptClock(learner("lina"), "att", t("16:29"))).toMatchObject({ status: "IN_PROGRESS", remainingSeconds: 60 });
    expect(await getMyAttemptClock(learner("lina"), "att", t("16:30"))).toMatchObject({ status: "AUTO_SUBMITTED" });
  });

  it("FULL_DURATION: start + duration, and a batch extension adds to it", () => {
    seed("FULL_DURATION");
    expect(initialDeadline(t("16:25"), assessments.get("exam") as never)).toEqual({ deadlineAt: t("16:55"), extensionSeconds: 0 });
    Object.assign(assessments.get("exam")!, { batchExtensionSeconds: 180 * MIN });
    expect(initialDeadline(t("16:25"), assessments.get("exam") as never)).toEqual({ deadlineAt: t("19:55"), extensionSeconds: 180 * MIN });
  });

  it("no batch extension recorded (the default for every existing assessment): identical to the original deadline", () => {
    expect(initialDeadline(t("16:10"), { timingMode: "WINDOW", endAt: t("16:30"), durationMinutes: 30 } as never)).toEqual({ deadlineAt: t("16:30"), extensionSeconds: 0 });
  });
});
