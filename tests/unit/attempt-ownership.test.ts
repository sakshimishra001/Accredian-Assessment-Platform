import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Regression: "Attempt not found" — answers not saved, no proctoring violations recorded.
 *
 * A learner signed in with a legacy exam password (issued for assessment A) took a different
 * assessment B they are also assigned to. The page served B (it takes the assessment from the URL),
 * but every attempt action — autosave, the clock, every proctoring report — looked the attempt up
 * narrowed by the session's default assessment A, so the learner's own running attempt was "not
 * found": nothing was saved and no focus / fullscreen / camera / clipboard / face event was recorded.
 *
 * These tests run the real attempt service against an in-memory stand-in for the database (the
 * lookups really filter on their where-clauses), so the broken narrowing would fail them.
 */

type Row = Record<string, unknown>;
const NOW = new Date("2026-10-18T11:05:00Z");
const assessments = new Map<string, Row>();
const attempts = new Map<string, Row>();
const responses = new Map<string, Row>();
const events: Row[] = [];
const audits: Row[] = [];
const questions = [{ id: "q1", assessmentId: "assessment-B", snapshot: { type: "MCQ_SINGLE", text: "Pick", options: [{ id: "o1", text: "A" }, { id: "o2", text: "B" }] }, paperQuestion: null, responses: [] }];

/** Equality on the plain fields of a where-clause (what the attempt lookups use). */
const matches = (row: Row, where: Row) => Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);
const withAssessment = (a: Row) => ({ ...a, assessment: assessments.get(a.assessmentId as string), _count: { responses: [...responses.keys()].filter((k) => k.startsWith(`${a.id}:`)).length } });

let queue: Promise<unknown> = Promise.resolve();
const fakeDb = {
  assessmentAttempt: {
    findFirst: async ({ where }: { where: Row }) => {
      const a = [...attempts.values()].find((r) => matches(r, where));
      return a ? withAssessment(a) : null;
    },
    findUnique: async ({ where }: { where: { id: string } }) => (attempts.get(where.id) ? withAssessment(attempts.get(where.id)!) : null),
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const a = attempts.get(where.id);
      if (!a) throw new Error("not found");
      return withAssessment(a);
    },
    count: async ({ where }: { where: Row }) => [...attempts.values()].filter((r) => matches(r, where)).length,
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const a = attempts.get(where.id as string);
      if (!a || (where.status && a.status !== where.status)) return { count: 0 };
      Object.assign(a, data);
      return { count: 1 };
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(attempts.get(where.id)!, data),
  },
  assessment: { findUniqueOrThrow: async ({ where }: { where: { id: string } }) => assessments.get(where.id) },
  assessmentQuestion: {
    findMany: async ({ where }: { where: { assessmentId: string; id?: { in: string[] } } }) => questions.filter((q) => q.assessmentId === where.assessmentId && (!where.id || where.id.in.includes(q.id))),
  },
  attemptResponse: {
    findMany: async () => [],
    findUnique: async ({ where }: { where: { attemptId_assessmentQuestionId: { attemptId: string; assessmentQuestionId: string } } }) => {
      const k = where.attemptId_assessmentQuestionId;
      return responses.get(`${k.attemptId}:${k.assessmentQuestionId}`) ?? null;
    },
    upsert: async ({ where, create, update }: { where: { attemptId_assessmentQuestionId: { attemptId: string; assessmentQuestionId: string } }; create: Row; update: Row }) => {
      const k = `${where.attemptId_assessmentQuestionId.attemptId}:${where.attemptId_assessmentQuestionId.assessmentQuestionId}`;
      responses.set(k, { ...(responses.get(k) ?? create), ...update });
    },
  },
  proctoringEvent: {
    create: async ({ data }: { data: Row }) => {
      events.push(data);
      return { id: `event-${events.length}` };
    },
  },
  auditLog: { create: async ({ data }: { data: Row }) => void audits.push(data) },
  // Transactions run one at a time, as the attempt row lock makes them in PostgreSQL.
  $transaction: <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const run = queue.then(() => fn(fakeDb));
    queue = run.catch(() => undefined);
    return run;
  },
};

vi.mock("@/server/db", () => ({ db: fakeDb }));
vi.stubEnv("DATABASE_URL", "postgresql://unit:unit@localhost:5432/unit_test");

const { recordProctoringEvent, saveResponses, getMyAttemptClock, submitAttempt } = await import("@/server/services/attempts");
const { monitoringBus } = await import("@/server/realtime/bus");
const { NotFoundError } = await import("@/lib/errors");
const { createFocusMonitor } = await import("@/lib/proctoring/focus-monitor");
const { createFullscreenMonitor, createDepartureTracker } = await import("@/lib/proctoring/fullscreen-monitor");
const { createClipboardMonitor } = await import("@/lib/proctoring/clipboard-monitor");
const { createCameraMonitor } = await import("@/lib/proctoring/camera-monitor");
const { createExpectedInteractions } = await import("@/lib/proctoring/expected-interactions");
type SessionUser = import("@/server/auth/session").SessionUser;

/** The learner as their legacy exam-password session sees them: defaulting to assessment A. */
const legacyLearner: SessionUser = { id: "lina", email: "lina@example.com", name: "Lina", role: "LEARNER", assessmentId: "assessment-A", examCredentialId: "cred-A", sessionId: "s1" };
/** The same learner with a password session (no default assessment). */
const passwordLearner: SessionUser = { id: "lina", email: "lina@example.com", name: "Lina", role: "LEARNER", sessionId: "s2" };
const otherLearner: SessionUser = { id: "leo", email: "leo@example.com", name: "Leo", role: "LEARNER", sessionId: "s3" };

const PROCTORED = {
  proctoringEnabled: true,
  focusMonitoringEnabled: true,
  fullscreenEnabled: true,
  clipboardMonitoringEnabled: true,
  cameraRequired: true,
  faceDetectionEnabled: true,
  faceMissingDetectionEnabled: true,
  multipleFaceDetectionEnabled: true,
};

function seed(policy: { max?: number; action?: "WARN" | "LOCK" | "TERMINATE" } = {}) {
  assessments.clear();
  attempts.clear();
  responses.clear();
  events.length = 0;
  audits.length = 0;
  const assessment = (id: string) => ({
    id,
    status: "ACTIVE",
    timingMode: "FULL_DURATION",
    startAt: new Date("2026-10-18T10:00:00Z"),
    endAt: new Date("2026-10-18T14:00:00Z"),
    durationMinutes: 60,
    pausedAt: null,
    allowMarkForReview: true,
    ...PROCTORED,
    focusMaxViolations: policy.max ?? 10,
    focusViolationAction: policy.action ?? "WARN",
  });
  assessments.set("assessment-A", assessment("assessment-A"));
  assessments.set("assessment-B", assessment("assessment-B"));
  // Lina's running attempt is in B — not in the assessment her legacy session defaults to.
  attempts.set("attempt-B", {
    id: "attempt-B",
    assessmentId: "assessment-B",
    learnerId: "lina",
    candidateId: "cand-B",
    status: "IN_PROGRESS",
    startedAt: new Date("2026-10-18T11:01:55Z"),
    deadlineAt: new Date("2026-10-18T12:01:55Z"),
    pausedSeconds: 0,
    extensionSeconds: 0,
    lockedAt: null,
    focusViolations: 0,
    focusLastIncidentId: null,
  });
}

beforeEach(() => seed());

describe("the learner's own attempt is found whatever assessment their session defaults to", () => {
  it("autosave works: the answer is stored on the attempt the exam screen shows (the same id)", async () => {
    for (const actor of [legacyLearner, passwordLearner]) {
      const r = await saveResponses(actor, "attempt-B", { responses: [{ assessmentQuestionId: "q1", selectedOptionIds: ["o1"], clientSeq: actor === legacyLearner ? 1 : 2 }] }, NOW);
      expect(r).toMatchObject({ saved: 1, ignored: 0 });
    }
    expect(responses.get("attempt-B:q1")).toMatchObject({ attemptId: "attempt-B", assessmentId: "assessment-B", selectedOptionIds: ["o1"], clientSeq: 2 });
  });

  it("the clock poll finds it", async () => {
    expect(await getMyAttemptClock(legacyLearner, "attempt-B", NOW)).toMatchObject({ status: "IN_PROGRESS", locked: false });
  });

  it("proctoring events are recorded on it and counted", async () => {
    expect(await recordProctoringEvent(legacyLearner, "attempt-B", { eventType: "FOCUS_LOST", incidentId: "incident-0001" }, NOW)).toMatchObject({ recorded: true, outcome: "WARNING", violations: 1 });
    expect(events[0]).toMatchObject({ attemptId: "attempt-B", eventType: "FOCUS_LOST", violationNumber: 1 });
  });

  it("authorization is unchanged: another learner's attempt is still \"not found\"", async () => {
    await expect(saveResponses(otherLearner, "attempt-B", { responses: [{ assessmentQuestionId: "q1", selectedOptionIds: ["o1"] }] }, NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordProctoringEvent(otherLearner, "attempt-B", { eventType: "FOCUS_LOST", incidentId: "incident-0002" }, NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getMyAttemptClock(otherLearner, "missing-attempt", NOW)).rejects.toBeInstanceOf(NotFoundError);
    expect(events).toHaveLength(0);
    expect(responses.size).toBe(0);
  });

  it("an answer for a question outside the attempt's assessment is still refused", async () => {
    questions[0].assessmentId = "assessment-A";
    try {
      await expect(saveResponses(legacyLearner, "attempt-B", { responses: [{ assessmentQuestionId: "q1", selectedOptionIds: ["o1"] }] }, NOW)).rejects.toMatchObject({ name: expect.any(String) });
      expect(responses.size).toBe(0);
    } finally {
      questions[0].assessmentId = "assessment-B";
    }
  });
});

/**
 * Browser monitor → departure tracker → expected interactions → the real server service → event →
 * shared counter → action. The monitors are the real ones; the "action" is a direct call to
 * recordProctoringEvent (what recordProctoringEventAction does after authenticating the session).
 */
function exam(actor: SessionUser = legacyLearner) {
  let t = 0;
  const timers = new Set<{ at: number; fn: () => void }>();
  const env = { focus: true, visible: true, frame: false, fullscreen: true };
  let n = 0;
  const departures = createDepartureTracker(() => `incident-${String(++n).padStart(4, "0")}`);
  const expected = createExpectedInteractions(() => t);
  const sent: Promise<unknown>[] = [];
  const report = (eventType: string, incidentId: string) => sent.push(recordProctoringEvent(actor, "attempt-B", { eventType, incidentId }, NOW));
  const focus = createFocusMonitor({
    isIdle: () => false,
    hasFocus: () => env.focus,
    focusInFrame: () => env.frame,
    isVisible: () => env.visible,
    expected,
    onLeave: () => report("FOCUS_LOST", departures.leave("focus")),
    onBack: () => departures.back("focus"),
    setTimer: (fn, ms) => {
      const x = { at: t + ms, fn };
      timers.add(x);
      return x;
    },
    clearTimer: (x) => void timers.delete(x as { at: number; fn: () => void }),
  });
  const fullscreen = createFullscreenMonitor({ isFullscreen: () => env.fullscreen, isIdle: () => false, isExpected: () => expected.covers("fullscreen"), onExit: () => report("FULLSCREEN_EXIT", departures.leave("fullscreen")) });
  const clipboard = createClipboardMonitor({ isIdle: () => false, report: (type) => report(type, `clip-${++n}-${crypto.randomUUID().slice(0, 8)}`) });
  const camera = createCameraMonitor({ isIdle: () => false, onLoss: (type) => report(type, departures.leave("camera")) });
  camera.ready();
  const advance = (ms: number) => {
    t += ms;
    for (const x of [...timers].sort((a, b) => a.at - b.at)) {
      if (x.at > t) continue;
      timers.delete(x);
      x.fn();
    }
  };
  return {
    env,
    expected,
    advance,
    blur: () => {
      env.focus = false;
      focus.blur();
    },
    refocus: () => {
      env.focus = true;
      focus.focus();
    },
    hide: () => {
      env.visible = false;
      focus.visibilityChange();
    },
    show: () => {
      env.visible = true;
      focus.visibilityChange();
    },
    exitFullscreen: () => {
      env.fullscreen = false;
      return fullscreen.sync();
    },
    enterFullscreen: () => {
      env.fullscreen = true;
      return fullscreen.sync();
    },
    clipboard,
    camera,
    departures,
    settled: () => Promise.all(sent),
    recorded: () => events.map((e) => e.eventType),
  };
}

describe("proctoring, end to end — genuine departures are violations", () => {
  it("1: switching to another tab, or to another app/window, records FOCUS_LOST", async () => {
    const e = exam();
    e.hide(); // another tab
    e.show();
    e.blur(); // another app
    e.advance(1_000);
    await e.settled();
    expect(e.recorded()).toEqual(["FOCUS_LOST", "FOCUS_LOST"]);
    expect(events.map((x) => x.violationNumber)).toEqual([1, 2]);
  });

  it("3: exiting fullscreen records FULLSCREEN_EXIT", async () => {
    const e = exam();
    expect(e.exitFullscreen()).toBe("exited");
    await e.settled();
    expect(e.recorded()).toEqual(["FULLSCREEN_EXIT"]);
  });

  it("4: a lost camera records CAMERA_DISABLED / CAMERA_PERMISSION_REVOKED", async () => {
    const e = exam();
    e.camera.lost("CAMERA_PERMISSION_REVOKED");
    e.departures.back("camera");
    e.camera.ready();
    e.camera.lost("CAMERA_DISABLED");
    await e.settled();
    expect(e.recorded()).toEqual(["CAMERA_PERMISSION_REVOKED", "CAMERA_DISABLED"]);
  });

  it("5: monitored clipboard actions are recorded (never their contents)", async () => {
    const e = exam();
    e.clipboard.handle("copy", {});
    e.clipboard.handle("paste", {});
    await e.settled();
    expect(e.recorded()).toEqual(["CLIPBOARD_COPY", "CLIPBOARD_PASTE"]);
    expect(events.every((x) => x.metadata === undefined)).toBe(true);
  });

  it("enforcement still applies: the shared counter reaches the limit and the attempt is terminated", async () => {
    seed({ max: 2, action: "TERMINATE" });
    const e = exam();
    e.hide();
    e.show();
    e.clipboard.handle("copy", {});
    await e.settled();
    expect(attempts.get("attempt-B")).toMatchObject({ status: "TERMINATED", focusViolations: 2, terminatedById: null });
  });

  it("one physical departure is still one violation (focus + fullscreen share the incident)", async () => {
    const e = exam();
    e.exitFullscreen();
    e.blur();
    e.advance(1_000);
    await e.settled();
    expect(events).toHaveLength(1);
  });
});

describe("proctoring, end to end — legitimate exam interactions are not", () => {
  it("2: viewing a supporting document in the built-in viewer (focus inside its frame) records nothing", async () => {
    const e = exam();
    e.env.frame = true;
    e.blur();
    e.advance(30_000);
    await e.settled();
    expect(events).toHaveLength(0);
  });

  it("2: downloading a document, the native file picker (upload / replace) record nothing — including the forced fullscreen exit", async () => {
    const e = exam();
    e.expected.expect("download");
    e.blur();
    e.advance(10_000);
    e.refocus();
    e.expected.expect("file-picker");
    e.exitFullscreen();
    e.blur();
    e.advance(60_000);
    e.refocus();
    e.enterFullscreen();
    await e.settled();
    expect(events).toHaveLength(0);
  });

  it("6: an expected interaction doesn't suppress monitoring afterwards", async () => {
    const e = exam();
    // A file picker that was used and closed…
    e.expected.expect("file-picker");
    e.blur();
    e.advance(2_000);
    e.refocus();
    // …a download that never took focus (its announcement expires)…
    e.expected.expect("download");
    e.advance(6_000);
    // …a camera permission prompt that has closed…
    e.expected.expect("permission-prompt")();
    // …then a genuine departure is recorded as usual.
    e.blur();
    e.advance(1_000);
    e.refocus();
    expect(e.exitFullscreen()).toBe("exited");
    await e.settled();
    expect(e.recorded()).toEqual(["FOCUS_LOST", "FULLSCREEN_EXIT"]);
  });
});

describe("live monitoring events from the attempt engine (phase 5)", () => {
  function listen() {
    const got: string[] = [];
    const off = monitoringBus.subscribe("assessment-B", (e) => got.push(`${e.type}:${e.attemptId}`));
    return { got, off };
  }

  it("a recorded violation publishes PROCTORING_VIOLATION; a repeated incident publishes nothing", async () => {
    const l = listen();
    await recordProctoringEvent(passwordLearner, "attempt-B", { eventType: "FOCUS_LOST", incidentId: "incident-aaaa" }, NOW);
    await recordProctoringEvent(passwordLearner, "attempt-B", { eventType: "FULLSCREEN_EXIT", incidentId: "incident-aaaa" }, NOW);
    expect(l.got).toEqual(["PROCTORING_VIOLATION:attempt-B"]);
    l.off();
  });

  it("the violation that reaches the limit also publishes the lock or termination", async () => {
    seed({ max: 1, action: "LOCK" });
    let l = listen();
    await recordProctoringEvent(passwordLearner, "attempt-B", { eventType: "FOCUS_LOST", incidentId: "incident-bbbb" }, NOW);
    expect(l.got).toEqual(["PROCTORING_VIOLATION:attempt-B", "ATTEMPT_LOCKED:attempt-B"]);
    l.off();
    seed({ max: 1, action: "TERMINATE" });
    l = listen();
    await recordProctoringEvent(passwordLearner, "attempt-B", { eventType: "FOCUS_LOST", incidentId: "incident-cccc" }, NOW);
    expect(l.got).toEqual(["PROCTORING_VIOLATION:attempt-B", "ATTEMPT_TERMINATED:attempt-B"]);
    l.off();
  });

  it("submitting publishes ATTEMPT_SUBMITTED once; submitting again publishes nothing", async () => {
    const l = listen();
    await submitAttempt(passwordLearner, "attempt-B", { responses: [] }, NOW);
    await submitAttempt(passwordLearner, "attempt-B", { responses: [] }, NOW);
    expect(l.got).toEqual(["ATTEMPT_SUBMITTED:attempt-B"]);
    l.off();
  });

  it("the deadline passing publishes ATTEMPT_AUTO_SUBMITTED (when the attempt is closed)", async () => {
    const l = listen();
    expect(await getMyAttemptClock(passwordLearner, "attempt-B", new Date("2026-10-18T12:30:00Z"))).toMatchObject({ status: "AUTO_SUBMITTED" });
    expect(l.got).toEqual(["ATTEMPT_AUTO_SUBMITTED:attempt-B"]);
    l.off();
  });

  it("a refused action publishes nothing", async () => {
    const l = listen();
    await expect(recordProctoringEvent(otherLearner, "attempt-B", { eventType: "FOCUS_LOST", incidentId: "incident-dddd" }, NOW)).rejects.toBeInstanceOf(NotFoundError);
    expect(l.got).toEqual([]);
    l.off();
  });
});

describe("camera / screen notices (phase 7) are recorded, never counted", () => {
  it("screen sharing stopped / denied and camera connected never lock or terminate — even with a limit of 1 and TERMINATE", async () => {
    seed({ max: 1, action: "TERMINATE" });
    Object.assign(assessments.get("assessment-B")!, { screenMonitoringEnabled: true });
    const published: string[] = [];
    const off = monitoringBus.subscribe("assessment-B", (e) => published.push(e.type));
    for (const eventType of ["SCREEN_SHARE_STOPPED", "SCREEN_SHARE_PERMISSION_DENIED", "SCREEN_SHARE_STARTED", "CAMERA_CONNECTED"]) {
      expect(await recordProctoringEvent(passwordLearner, "attempt-B", { eventType }, NOW)).toMatchObject({ recorded: true, outcome: "RECORDED", violations: 0 });
    }
    off();
    expect(attempts.get("attempt-B")).toMatchObject({ status: "IN_PROGRESS", lockedAt: null, focusViolations: 0 });
    expect(events.map((e) => [e.eventType, e.violationNumber ?? null])).toEqual([
      ["SCREEN_SHARE_STOPPED", null],
      ["SCREEN_SHARE_PERMISSION_DENIED", null],
      ["SCREEN_SHARE_STARTED", null],
      ["CAMERA_CONNECTED", null],
    ]);
    expect(published).toEqual([]); // no violation, lock or termination
  });

  it("screen notices are ignored when screen monitoring is off", async () => {
    expect(await recordProctoringEvent(passwordLearner, "attempt-B", { eventType: "SCREEN_SHARE_STOPPED" }, NOW)).toMatchObject({ recorded: false, outcome: "IGNORED" });
    expect(events).toEqual([]);
  });
});

describe("only security violations count towards the limit — camera / face / screen observations never do", () => {
  const OBSERVATIONS = [
    ["1: no face", "FACE_NOT_DETECTED"],
    ["2: multiple faces", "MULTIPLE_FACES"],
    ["3: camera disconnected", "CAMERA_DISABLED"],
    ["4: camera permission denied", "CAMERA_PERMISSION_REVOKED"],
    ["5: screen sharing stopped", "SCREEN_SHARE_STOPPED"],
    ["6: screen sharing permission denied", "SCREEN_SHARE_PERMISSION_DENIED"],
  ] as const;

  function seedWithScreen(policy: { max?: number; action?: "WARN" | "LOCK" | "TERMINATE" } = {}) {
    seed(policy);
    Object.assign(assessments.get("assessment-B")!, { screenMonitoringEnabled: true });
  }

  for (const [label, eventType] of OBSERVATIONS) {
    it(`${label} (${eventType}) is recorded for the proctor but does not increment the violation count`, async () => {
      seedWithScreen();
      const r = await recordProctoringEvent(passwordLearner, "attempt-B", { eventType, incidentId: "incident-obs1" }, NOW);
      expect(r).toMatchObject({ recorded: true, outcome: "RECORDED", violations: 0 });
      expect(attempts.get("attempt-B")!.focusViolations).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventType });
      expect(events[0].violationNumber ?? null).toBeNull();
    });
  }

  for (const [label, eventType] of [
    ["7: focus / tab", "FOCUS_LOST"],
    ["8: fullscreen", "FULLSCREEN_EXIT"],
    ["9: clipboard", "CLIPBOARD_COPY"],
  ] as const) {
    it(`${label} violations (${eventType}) still increment the violation count`, async () => {
      seedWithScreen();
      const first = await recordProctoringEvent(passwordLearner, "attempt-B", { eventType, incidentId: "incident-sec1" }, NOW);
      const second = await recordProctoringEvent(passwordLearner, "attempt-B", { eventType, incidentId: "incident-sec2" }, NOW);
      expect([first.violations, second.violations]).toEqual([1, 2]);
      expect(attempts.get("attempt-B")!.focusViolations).toBe(2);
      expect(events.map((e) => e.violationNumber)).toEqual([1, 2]);
    });
  }

  it("a shared incident: a face observation no longer uses up the focus violation of the same departure", async () => {
    seedWithScreen();
    await recordProctoringEvent(passwordLearner, "attempt-B", { eventType: "FACE_NOT_DETECTED", incidentId: "incident-dep1" }, NOW);
    const focus = await recordProctoringEvent(passwordLearner, "attempt-B", { eventType: "FOCUS_LOST", incidentId: "incident-dep1" }, NOW);
    expect(focus).toMatchObject({ recorded: true, violations: 1 });
  });

  for (const action of ["LOCK", "TERMINATE"] as const) {
    it(`10: camera / face / screen events can't trigger the automatic ${action} — even at a limit of 1; a security violation still does`, async () => {
      seedWithScreen({ max: 1, action });
      const published: string[] = [];
      const off = monitoringBus.subscribe("assessment-B", (e) => published.push(e.type));
      let i = 0;
      for (const [, eventType] of OBSERVATIONS) {
        expect(await recordProctoringEvent(passwordLearner, "attempt-B", { eventType, incidentId: `incident-ob${++i}x` }, NOW)).toMatchObject({ outcome: "RECORDED", violations: 0 });
      }
      expect(attempts.get("attempt-B")).toMatchObject({ status: "IN_PROGRESS", lockedAt: null, focusViolations: 0 });
      expect(published).toEqual([]);
      expect(audits).toEqual([]);
      // The configured action still applies to a real security violation.
      const r = await recordProctoringEvent(passwordLearner, "attempt-B", { eventType: "FOCUS_LOST", incidentId: "incident-sec9" }, NOW);
      expect(r.outcome).toBe(action === "LOCK" ? "LOCKED" : "TERMINATED");
      off();
    });
  }
});
