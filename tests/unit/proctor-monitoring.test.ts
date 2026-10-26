import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeEvents, summarizeViolations } from "@/lib/proctoring/violation-summary";

/*
 * Proctor dashboard, phase 2: read-only monitoring. The real services run against an in-memory
 * stand-in for the database whose queries apply their where-clauses, so scoping mistakes fail here.
 * tests/integration/proctor-monitoring.test.ts covers the same against PostgreSQL.
 */

const NOW = new Date("2026-10-22T10:00:00Z");
type Role = "ADMIN" | "EXAMINER" | "REVIEWER" | "LEARNER";
const users = new Map<string, { id: string; role: Role; status: string; name: string; email: string }>();
const assessments = new Map<string, Record<string, unknown> & { id: string; status: string }>();
const proctors: { assessmentId: string; proctorId: string }[] = [];
const candidates: { assessmentId: string; learnerId: string }[] = [];
const attempts: (Record<string, unknown> & { id: string; assessmentId: string; learnerId: string; status: string })[] = [];
const events: (Record<string, unknown> & { id: string; attemptId: string; eventType: string; violationNumber: number | null; timestamp: Date })[] = [];
const audits: { id: string; entityType: string; entityId: string; action: string; actorId: string | null; createdAt: Date; metadata: Record<string, unknown> }[] = [];
const auditQueries: string[] = [];
const evidenceRows: { id: string; assessmentId: string; attemptId: string; type: "CAMERA" | "SCREEN"; capturedAt: Date; fileSize: number }[] = [];

const assessmentWhere = (a: { id: string; status: string }, where: Record<string, unknown>) => {
  if (where.id && where.id !== a.id) return false;
  const status = where.status as { in?: string[] } | undefined;
  if (status?.in && !status.in.includes(a.status)) return false;
  const some = (where.proctors as { some?: { proctorId: string; proctor?: { status: string } } } | undefined)?.some;
  if (some && !proctors.some((p) => p.assessmentId === a.id && p.proctorId === some.proctorId && (!some.proctor || users.get(p.proctorId)?.status === some.proctor.status))) return false;
  return true;
};
const shapeAssessment = (a: Record<string, unknown> & { id: string }) => ({
  ...a,
  batch: { name: "Batch 1" },
  _count: { candidates: candidates.filter((c) => c.assessmentId === a.id).length, attempts: attempts.filter((t) => t.assessmentId === a.id && t.status === "IN_PROGRESS").length },
});
const shapeAttempt = (t: (typeof attempts)[number]) => ({
  ...t,
  learner: { id: t.learnerId, name: users.get(t.learnerId)!.name, email: users.get(t.learnerId)!.email },
  assessment: assessments.get(t.assessmentId),
  _count: { responses: 2 },
});

const fakeDb = {
  assessment: {
    findMany: async ({ where }: { where: Record<string, unknown> }) => [...assessments.values()].filter((a) => assessmentWhere(a, where)).map(shapeAssessment),
    findUnique: async ({ where }: { where: { id: string } }) => (assessments.get(where.id) ? shapeAssessment(assessments.get(where.id)!) : null),
    count: async ({ where }: { where: { id: string } }) => (assessments.has(where.id) ? 1 : 0),
  },
  assessmentProctor: {
    count: async ({ where }: { where: { assessmentId: string; proctorId: string; proctor?: { status: string } } }) =>
      proctors.filter((p) => p.assessmentId === where.assessmentId && p.proctorId === where.proctorId && (!where.proctor || users.get(p.proctorId)?.status === where.proctor.status)).length,
  },
  assessmentCandidate: { count: async ({ where }: { where: { assessmentId: string } }) => candidates.filter((c) => c.assessmentId === where.assessmentId).length },
  assessmentAttempt: {
    findMany: async ({ where }: { where: { assessmentId: string; status: string } }) => attempts.filter((t) => t.assessmentId === where.assessmentId && t.status === where.status).map(shapeAttempt),
    findFirst: async ({ where }: { where: { id: string; assessmentId: string } }) => {
      const t = attempts.find((x) => x.id === where.id && x.assessmentId === where.assessmentId);
      return t ? shapeAttempt(t) : null;
    },
    findUnique: async ({ where }: { where: { id: string } }) => attempts.find((x) => x.id === where.id) ?? null,
    count: async ({ where }: { where: { id: string } }) => attempts.filter((x) => x.id === where.id).length,
  },
  proctoringEvent: {
    groupBy: async ({ where }: { where: { attemptId: { in: string[] }; violationNumber: { not: null } } }) => {
      const groups = new Map<string, { attemptId: string; eventType: string; _count: { _all: number } }>();
      for (const e of events.filter((x) => where.attemptId.in.includes(x.attemptId) && x.violationNumber !== null)) {
        const k = `${e.attemptId}:${e.eventType}`;
        const g = groups.get(k) ?? { attemptId: e.attemptId, eventType: e.eventType, _count: { _all: 0 } };
        g._count._all++;
        groups.set(k, g);
      }
      return [...groups.values()];
    },
    findMany: async ({ where }: { where: { attemptId: string } }) => events.filter((e) => e.attemptId === where.attemptId).sort((a, b) => +a.timestamp - +b.timestamp),
  },
  proctorNotification: { findMany: async () => [] },
  proctoringEvidence: {
    groupBy: async ({ where }: { where: { assessmentId: string; attemptId: { in: string[] } } }) => {
      const counts = new Map<string, number>();
      for (const x of evidenceRows.filter((r) => r.assessmentId === where.assessmentId && where.attemptId.in.includes(r.attemptId))) counts.set(x.attemptId, (counts.get(x.attemptId) ?? 0) + 1);
      return [...counts].map(([attemptId, n]) => ({ attemptId, _count: { _all: n } }));
    },
    findMany: async ({ where }: { where: { attemptId: string; assessmentId: string } }) => evidenceRows.filter((x) => x.attemptId === where.attemptId && x.assessmentId === where.assessmentId),
  },
  auditLog: {
    findMany: async ({ where }: { where: { entityType: string; entityId: string; action: { in: string[] }; actorId: { not: null } } }) => {
      auditQueries.push(where.entityId);
      return audits
        .filter((x) => x.entityType === where.entityType && x.entityId === where.entityId && where.action.in.includes(x.action) && x.actorId !== null)
        .sort((a, b) => +a.createdAt - +b.createdAt)
        .map((x) => ({ id: x.id, action: x.action, createdAt: x.createdAt, metadata: x.metadata, actor: x.actorId ? { name: users.get(x.actorId)!.name, role: users.get(x.actorId)!.role } : null }));
    },
  },
};

vi.mock("@/server/db", () => ({ db: fakeDb }));
vi.mock("@/server/services/assessments", () => ({ syncTimeBasedStatuses: async () => undefined, creditPause: async () => undefined }));
vi.mock("@/server/services/attempts", async (importOriginal) => ({ ...(await importOriginal<object>()), closeExpiredAttempts: async () => 0 }));
vi.stubEnv("DATABASE_URL", "postgresql://unit:unit@localhost:5432/unit_test");

const { listProctorAssessments, getProctorMonitoring, getProctorAttempt, authorizeMonitoringStream } = await import("@/server/services/proctor-monitoring");
const { manualActionText, timelineRows } = await import("@/app/proctor/assessments/[id]/attempts/[attemptId]/proctor-timeline");
const { ForbiddenError, NotFoundError } = await import("@/lib/errors");
const { presenceStore } = await import("@/server/realtime/presence");

const actor = (id: string) => {
  const u = users.get(id)!;
  return { id: u.id, email: u.email, name: u.name, role: u.role };
};

let n = 0;
function event(attemptId: string, eventType: string, violationNumber: number | null, minute: number) {
  events.push({ id: `ev-${++n}`, attemptId, eventType, violationNumber, timestamp: new Date(NOW.getTime() - (60 - minute) * 60_000), severity: "MEDIUM", actionTaken: null, durationMs: null, metadata: null });
}

beforeEach(() => {
  users.clear();
  assessments.clear();
  proctors.length = 0;
  candidates.length = 0;
  attempts.length = 0;
  events.length = 0;
  audits.length = 0;
  auditQueries.length = 0;
  evidenceRows.length = 0;
  for (const [id, role] of [
    ["admin", "ADMIN"],
    ["pat", "REVIEWER"],
    ["quinn", "REVIEWER"],
    ["eve", "EXAMINER"],
    ["lina", "LEARNER"],
    ["leo", "LEARNER"],
    ["mia", "LEARNER"],
  ] as const)
    users.set(id, { id, role, status: "ACTIVE", name: id[0].toUpperCase() + id.slice(1), email: `${id}@example.com` });
  const settings = {
    name: "",
    startAt: new Date("2026-10-22T09:00:00Z"),
    endAt: new Date("2026-10-22T12:00:00Z"),
    pausedAt: null,
    timingMode: "FULL_DURATION",
    durationMinutes: 60,
    proctoringEnabled: true,
    focusMonitoringEnabled: true,
    fullscreenEnabled: true,
    clipboardMonitoringEnabled: true,
    cameraRequired: false,
    faceDetectionEnabled: false,
    multipleFaceDetectionEnabled: false,
    faceMissingDetectionEnabled: false,
    focusMaxViolations: 5,
    focusViolationAction: "LOCK",
  };
  assessments.set("exam-A", { ...settings, id: "exam-A", name: "Exam A", status: "ACTIVE" });
  assessments.set("exam-B", { ...settings, id: "exam-B", name: "Exam B", status: "ACTIVE" });
  assessments.set("exam-draft", { ...settings, id: "exam-draft", name: "Draft", status: "DRAFT" });
  proctors.push({ assessmentId: "exam-A", proctorId: "pat" });
  candidates.push({ assessmentId: "exam-A", learnerId: "lina" }, { assessmentId: "exam-A", learnerId: "leo" }, { assessmentId: "exam-B", learnerId: "mia" });
  const attempt = (id: string, assessmentId: string, learnerId: string, status = "IN_PROGRESS", focusViolations = 0) =>
    attempts.push({
      id,
      assessmentId,
      learnerId,
      status,
      attemptNumber: 1,
      startedAt: new Date("2026-10-22T09:30:00Z"),
      deadlineAt: new Date("2026-10-22T10:30:00Z"),
      pausedSeconds: 0,
      extensionSeconds: 0,
      focusViolations,
      lockedAt: null,
      lastActivityAt: new Date("2026-10-22T09:58:00Z"),
      submittedAt: null,
      terminatedAt: null,
      terminatedById: null,
      terminationReason: null,
    });
  attempt("att-lina", "exam-A", "lina", "IN_PROGRESS", 4);
  attempt("att-leo", "exam-A", "leo", "SUBMITTED", 0);
  attempt("att-mia", "exam-B", "mia", "IN_PROGRESS", 1);
  event("att-lina", "PROCTORING_STARTED", null, 1);
  event("att-lina", "FOCUS_LOST", 1, 2);
  event("att-lina", "FULLSCREEN_EXIT", 2, 3);
  event("att-lina", "CLIPBOARD_COPY", 3, 4);
  event("att-lina", "CLIPBOARD_PASTE", 4, 5);
  event("att-lina", "FULLSCREEN_EXIT", null, 6); // deduplicated by the server: not a counted violation
  event("att-mia", "CLIPBOARD_CUT", 1, 2);
});

describe("violation counts by kind", () => {
  it("groups counted violations by type, with a total; system events and uncounted events are left out", () => {
    expect(
      summarizeViolations([
        { eventType: "FOCUS_LOST", count: 3 },
        { eventType: "FULLSCREEN_EXIT", count: 2 },
        { eventType: "CLIPBOARD_COPY", count: 1 },
        { eventType: "CLIPBOARD_CUT", count: 1 },
        { eventType: "CLIPBOARD_PASTE", count: 2 },
        { eventType: "CAMERA_DISABLED", count: 1 },
        { eventType: "PROCTORING_STARTED", count: 5 },
      ]),
    ).toEqual({ focus: 3, fullscreen: 2, clipboardCopy: 1, clipboardCut: 1, clipboardPaste: 2, clipboard: 4, other: 1, total: 10 });
    expect(
      summarizeEvents([
        { eventType: "FOCUS_LOST", violationNumber: 1 },
        { eventType: "FOCUS_LOST", violationNumber: null },
        { eventType: "PROCTORING_STARTED", violationNumber: null },
      ]).total,
    ).toBe(1);
  });
});

describe("assigned assessments", () => {
  it("a proctor sees only the assessments assigned to them", async () => {
    expect((await listProctorAssessments(actor("pat"), NOW)).map((a) => a.id)).toEqual(["exam-A"]);
    expect(await listProctorAssessments(actor("quinn"), NOW)).toEqual([]);
  });

  it("an administrator sees every published assessment (not drafts)", async () => {
    expect((await listProctorAssessments(actor("admin"), NOW)).map((a) => a.id).sort()).toEqual(["exam-A", "exam-B"]);
  });

  it("shows active attempts and assigned learners per assessment", async () => {
    const [a] = await listProctorAssessments(actor("pat"), NOW);
    expect(a).toMatchObject({ id: "exam-A", activeAttempts: 1, assignedLearners: 2, status: "ACTIVE" });
  });

  it("examiners and learners are refused", async () => {
    await expect(listProctorAssessments(actor("eve"), NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listProctorAssessments(actor("lina"), NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("monitoring an assessment", () => {
  it("an assigned proctor sees that assessment's running attempts only, with violations by kind", async () => {
    const m = await getProctorMonitoring(actor("pat"), "exam-A", NOW);
    expect(m.assessment).toMatchObject({ id: "exam-A", assignedLearners: 2 });
    expect(m.attempts.map((t) => t.id)).toEqual(["att-lina"]); // not the submitted one, not exam-B's
    expect(m.attempts[0]).toMatchObject({
      learner: { name: "Lina", email: "lina@example.com" },
      counted: 4,
      violations: { focus: 1, fullscreen: 1, clipboardCopy: 1, clipboardCut: 0, clipboardPaste: 1, clipboard: 2, other: 0, total: 4 },
      remainingSeconds: 30 * 60,
    });
  });

  it("another assessment is \"not found\" for that proctor — the URL grants nothing", async () => {
    await expect(getProctorMonitoring(actor("pat"), "exam-B", NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProctorMonitoring(actor("pat"), "no-such-exam", NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProctorMonitoring(actor("quinn"), "exam-A", NOW)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an administrator may monitor any assessment; examiners and learners can't", async () => {
    expect((await getProctorMonitoring(actor("admin"), "exam-B", NOW)).attempts.map((t) => t.id)).toEqual(["att-mia"]);
    await expect(getProctorMonitoring(actor("eve"), "exam-A", NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getProctorMonitoring(actor("lina"), "exam-A", NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("removing the assignment removes access", async () => {
    proctors.length = 0;
    await expect(getProctorMonitoring(actor("pat"), "exam-A", NOW)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("learner timeline", () => {
  it("shows the attempt and only its own events, oldest first, with the violation summary", async () => {
    const r = await getProctorAttempt(actor("pat"), "exam-A", "att-lina", NOW);
    expect(r.attempt).toMatchObject({ id: "att-lina", status: "IN_PROGRESS", learner: { name: "Lina" }, remainingSeconds: 30 * 60, terminatedBySystem: false });
    expect(r.events.map((e) => e.eventType)).toEqual(["PROCTORING_STARTED", "FOCUS_LOST", "FULLSCREEN_EXIT", "CLIPBOARD_COPY", "CLIPBOARD_PASTE", "FULLSCREEN_EXIT"]);
    expect(r.events.every((e) => !("attemptId" in e) || (e as { attemptId: string }).attemptId === "att-lina")).toBe(true);
    expect(r.violations).toMatchObject({ focus: 1, fullscreen: 1, clipboard: 2, total: 4 });
  });

  it("an attempt of another assessment is \"not found\", even through an assessment the proctor may see", async () => {
    await expect(getProctorAttempt(actor("pat"), "exam-A", "att-mia", NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProctorAttempt(actor("pat"), "exam-B", "att-mia", NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProctorAttempt(actor("eve"), "exam-A", "att-lina", NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a finished attempt can still be reviewed (no time remaining)", async () => {
    const r = await getProctorAttempt(actor("admin"), "exam-A", "att-leo", NOW);
    expect(r.attempt).toMatchObject({ status: "SUBMITTED", remainingSeconds: 0 });
  });
});

describe("manual actions in the proctor timeline", () => {
  const audit = (entityId: string, action: string, actorId: string | null, minute: number, reason?: string) =>
    audits.push({ id: `a-${audits.length + 1}`, entityType: "AssessmentAttempt", entityId, action, actorId, createdAt: new Date(NOW.getTime() - (60 - minute) * 60_000), metadata: { reason, assessmentId: "exam-A" } });

  it("a manual lock appears, with who did it and why", async () => {
    audit("att-lina", "attempt.locked", "pat", 7, "Learner repeatedly switched tabs.");
    const r = await getProctorAttempt(actor("pat"), "exam-A", "att-lina", NOW);
    expect(r.manualActions).toEqual([expect.objectContaining({ kind: "lock", actor: { name: "Pat", role: "Proctor" }, reason: "Learner repeatedly switched tabs." })]);
    expect(manualActionText(r.manualActions[0])).toBe("Attempt locked by Pat (Proctor)");
  });

  it("a manual termination appears; the violation limit's own lock (no actor) and unrelated audit records don't", async () => {
    audit("att-lina", "attempt.locked", null, 5); // violation limit: already a proctoring event
    audit("att-lina", "attempt.time_extended", "admin", 6, "Network issue"); // not a lock / terminate
    audit("att-mia", "attempt.terminated", "admin", 6, "Another attempt"); // another attempt
    audit("att-lina", "attempt.terminated", "admin", 8, "Unauthorized assistance observed.");
    const r = await getProctorAttempt(actor("pat"), "exam-A", "att-lina", NOW);
    expect(r.manualActions.map((a) => [a.kind, a.actor?.role, a.reason])).toEqual([["terminate", "Administrator", "Unauthorized assistance observed."]]);
    expect(manualActionText(r.manualActions[0])).toBe("Attempt terminated by Admin (Administrator)");
  });

  it("the timeline merges events and manual actions in time order, each marked by type", async () => {
    audit("att-lina", "attempt.locked", "pat", 4.5, "Tabs");
    const r = await getProctorAttempt(actor("pat"), "exam-A", "att-lina", NOW);
    const rows = timelineRows(r.events, r.manualActions);
    expect(rows.map((x) => (x.kind === "event" ? x.event.eventType : x.kind === "manual" ? `manual:${x.action.kind}` : `evidence:${x.evidence.type}`))).toEqual([
      "PROCTORING_STARTED",
      "FOCUS_LOST",
      "FULLSCREEN_EXIT",
      "CLIPBOARD_COPY",
      "manual:lock",
      "CLIPBOARD_PASTE",
      "FULLSCREEN_EXIT",
    ]);
  });

  it("an unauthorized proctor can't read another assessment's manual-action records (no audit query is even made)", async () => {
    audit("att-mia", "attempt.terminated", "admin", 6, "Secret reason");
    await expect(getProctorAttempt(actor("pat"), "exam-B", "att-mia", NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProctorAttempt(actor("pat"), "exam-A", "att-mia", NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProctorAttempt(actor("quinn"), "exam-A", "att-lina", NOW)).rejects.toBeInstanceOf(NotFoundError);
    expect(auditQueries).toEqual([]);
  });
});

describe("live event stream authorization (phase 5)", () => {
  it("an administrator and an assigned proctor may subscribe; the assessment id used is the server's", async () => {
    expect(await authorizeMonitoringStream(actor("admin"), "exam-B")).toBe("exam-B");
    expect(await authorizeMonitoringStream(actor("pat"), "exam-A")).toBe("exam-A");
  });

  it("an unassigned proctor, or another assessment, is not found (assessment isolation)", async () => {
    await expect(authorizeMonitoringStream(actor("quinn"), "exam-A")).rejects.toBeInstanceOf(NotFoundError);
    await expect(authorizeMonitoringStream(actor("pat"), "exam-B")).rejects.toBeInstanceOf(NotFoundError);
    await expect(authorizeMonitoringStream(actor("pat"), "no-such-exam")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a disabled proctor account is denied", async () => {
    users.get("pat")!.status = "DISABLED";
    await expect(authorizeMonitoringStream(actor("pat"), "exam-A")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("examiners and learners are refused", async () => {
    await expect(authorizeMonitoringStream(actor("eve"), "exam-A")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(authorizeMonitoringStream(actor("lina"), "exam-A")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("only published, non-archived assessments stream (not drafts)", async () => {
    await expect(authorizeMonitoringStream(actor("admin"), "exam-draft")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("learner presence (phase 6)", () => {
  const CONN = "11111111-2222-3333-4444-555555555555";
  beforeEach(() => presenceStore.clear());

  it("an assigned proctor (and an administrator) sees who is connected and when they were last seen", async () => {
    presenceStore.heartbeat({ attemptId: "att-lina", assessmentId: "exam-A", learnerId: "lina", connectionId: CONN });
    for (const who of ["pat", "admin"]) {
      const m = await getProctorMonitoring(actor(who), "exam-A", NOW);
      const p = m.attempts.find((t) => t.id === "att-lina")!.presence;
      expect(p.online).toBe(true);
      expect(p.lastSeenAt).toBeInstanceOf(Date);
      expect((await getProctorAttempt(actor(who), "exam-A", "att-lina", NOW)).presence.online).toBe(true);
    }
    // Never seen: offline, no time.
    expect((await getProctorMonitoring(actor("admin"), "exam-B", NOW)).attempts.find((t) => t.id === "att-mia")!.presence).toEqual({ online: false, lastSeenAt: null, status: { camera: null, face: null, screen: null } });
    presenceStore.clear();
  });

  it("an unassigned proctor can't see presence (not found), nor another assessment's", async () => {
    presenceStore.heartbeat({ attemptId: "att-lina", assessmentId: "exam-A", learnerId: "lina", connectionId: CONN });
    presenceStore.heartbeat({ attemptId: "att-mia", assessmentId: "exam-B", learnerId: "mia", connectionId: CONN });
    await expect(getProctorMonitoring(actor("quinn"), "exam-A", NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProctorAttempt(actor("quinn"), "exam-A", "att-lina", NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProctorMonitoring(actor("pat"), "exam-B", NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProctorAttempt(actor("pat"), "exam-A", "att-mia", NOW)).rejects.toBeInstanceOf(NotFoundError);
    // Exam A's view lists only exam A's attempts.
    expect((await getProctorMonitoring(actor("pat"), "exam-A", NOW)).attempts.map((t) => t.id)).toEqual(["att-lina"]);
    presenceStore.clear();
  });

  it("an attempt that has ended is never shown as online", async () => {
    presenceStore.heartbeat({ attemptId: "att-leo", assessmentId: "exam-A", learnerId: "leo", connectionId: CONN });
    const r = await getProctorAttempt(actor("pat"), "exam-A", "att-leo", NOW);
    expect(r.attempt.status).toBe("SUBMITTED");
    expect(r.presence.online).toBe(false);
    presenceStore.clear();
  });
});

describe("proctoring evidence on the dashboard (phase 7)", () => {
  const snap = (id: string, assessmentId: string, attemptId: string, type: "CAMERA" | "SCREEN", minute: number) =>
    evidenceRows.push({ id, assessmentId, attemptId, type, capturedAt: new Date(NOW.getTime() - (60 - minute) * 60_000), fileSize: 1000 });

  it("an assigned proctor sees each running attempt's evidence count and the attempt's snapshots; the timeline includes them in order", async () => {
    snap("x1", "exam-A", "att-lina", "CAMERA", 2.5);
    snap("x2", "exam-A", "att-lina", "SCREEN", 4.5);
    snap("x3", "exam-B", "att-mia", "CAMERA", 3);
    const m = await getProctorMonitoring(actor("pat"), "exam-A", NOW);
    expect(m.attempts.map((t) => [t.id, t.evidenceCount])).toEqual([["att-lina", 2]]);
    const r = await getProctorAttempt(actor("pat"), "exam-A", "att-lina", NOW);
    expect(r.evidence.map((e) => e.id)).toEqual(["x1", "x2"]);
    const kinds = timelineRows(r.events, r.manualActions, r.evidence).map((x) => (x.kind === "evidence" ? `evidence:${x.evidence.type}` : x.kind));
    expect(kinds.indexOf("evidence:CAMERA")).toBeLessThan(kinds.indexOf("evidence:SCREEN"));
  });

  it("an unassigned proctor can't see another assessment's evidence", async () => {
    snap("x1", "exam-A", "att-lina", "CAMERA", 2);
    await expect(getProctorAttempt(actor("quinn"), "exam-A", "att-lina", NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProctorMonitoring(actor("pat"), "exam-B", NOW)).rejects.toBeInstanceOf(NotFoundError);
  });
});
