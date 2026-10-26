import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cameraLossType, cameraProblem, createCameraMonitor } from "@/lib/proctoring/camera-monitor";
import { effectiveProctoring, eventEnabled, eventSeverity, isViolation, learnerCameraConfig, learnerScreenConfig, type ProctoringSettings } from "@/lib/proctoring/config";
import { EVIDENCE_MIN_GAP_MS, fitWithin, looksLikeJpeg, SNAPSHOT_WINDOW } from "@/lib/proctoring/evidence";
import { uploadSnapshot } from "@/lib/proctoring/evidence-upload";
import { createFaceMonitor, FACE_RULES, type FaceReport } from "@/lib/proctoring/face-monitor";
import type { MonitoringEvent } from "@/lib/proctoring/monitoring-events";
import { parseMonitoringStatus } from "@/lib/proctoring/monitoring-status";
import { createScreenMonitor, screenProblem, screenStateOf, sharedSurfaceOk, type ScreenEventType } from "@/lib/proctoring/screen-monitor";
import { createSnapshotScheduler, nextSnapshotDelay } from "@/lib/proctoring/snapshot-schedule";
import { allowsEvidenceImages, contentSecurityPolicy, originOf } from "@/lib/security/csp";
import { createMonitoringBus } from "@/server/realtime/bus";
import { createPresenceStore } from "@/server/realtime/presence";
import { createMonitoringStream } from "@/server/realtime/sse";

/*
 * Proctor dashboard, phase 7: proctoring evidence (camera / screen snapshots) and face detection.
 * The browser-side state machines and scheduler, the evidence service against an in-memory stand-in
 * for the database and storage (its queries apply their where-clauses, so scoping mistakes fail here),
 * the live events, and the exam's robustness. No database, browser or network is needed.
 */

const NOW = new Date("2026-10-26T10:00:00Z");
type Role = "ADMIN" | "EXAMINER" | "REVIEWER" | "LEARNER";
const users = new Map<string, { id: string; role: Role; status: string }>();
const assessments = new Map<string, Record<string, unknown> & { id: string }>();
const proctors: { assessmentId: string; proctorId: string }[] = [];
type Attempt = Record<string, unknown> & { id: string; assessmentId: string; learnerId: string; status: string; lockedAt: Date | null };
const attempts = new Map<string, Attempt>();
type Evidence = { id: string; assessmentId: string; attemptId: string; type: "CAMERA" | "SCREEN"; storagePath: string; storageDriver: string; mimeType: string; fileSize: number; capturedAt: Date };
const evidence: Evidence[] = [];
const attemptWrites: string[] = [];
let failCreate = false;

/** The private evidence store: objects by key, with the content type each was stored as. */
const objects = new Map<string, { data: Buffer; contentType?: string }>();
const signed: string[] = [];
let signedUrls = true;
const fakeStore = {
  name: "memory",
  put: async (key: string, data: Buffer, contentType?: string) => void objects.set(key, { data, contentType }),
  get: async (key: string) => {
    const o = objects.get(key);
    if (!o) throw Object.assign(new Error("Object not found."), { code: "ENOENT" });
    return o.data;
  },
  delete: async (key: string) => void objects.delete(key),
  signedUrl: undefined as undefined | ((key: string, seconds: number) => Promise<string>),
};

const attemptView = (a: Attempt) => ({ ...a, assessment: assessments.get(a.assessmentId) });
const fakeDb = {
  assessment: { count: async ({ where }: { where: { id: string } }) => (assessments.has(where.id) ? 1 : 0) },
  assessmentProctor: {
    count: async ({ where }: { where: { assessmentId: string; proctorId: string; proctor?: { status: string } } }) =>
      proctors.filter((p) => p.assessmentId === where.assessmentId && p.proctorId === where.proctorId && (!where.proctor || users.get(p.proctorId)?.status === where.proctor.status)).length,
  },
  assessmentAttempt: {
    findFirst: async ({ where }: { where: { id: string; learnerId?: string; assessmentId?: string } }) => {
      const a = attempts.get(where.id);
      if (!a || (where.learnerId && a.learnerId !== where.learnerId) || (where.assessmentId && a.assessmentId !== where.assessmentId)) return null;
      return attemptView(a);
    },
    update: async () => void attemptWrites.push("update"),
    updateMany: async () => (attemptWrites.push("updateMany"), { count: 0 }),
  },
  proctoringEvidence: {
    findFirst: async ({ where }: { where: { id?: string; attemptId: string; assessmentId?: string; type?: string } }) => {
      const rows = evidence.filter((e) => e.attemptId === where.attemptId && (!where.id || e.id === where.id) && (!where.assessmentId || e.assessmentId === where.assessmentId) && (!where.type || e.type === where.type));
      return rows.sort((x, y) => +y.capturedAt - +x.capturedAt)[0] ?? null;
    },
    count: async ({ where }: { where: { attemptId: string; type: string } }) => evidence.filter((e) => e.attemptId === where.attemptId && e.type === where.type).length,
    create: async ({ data }: { data: Omit<Evidence, "id"> }) => {
      if (failCreate) throw new Error("database unavailable");
      const row = { id: `ev-${evidence.length + 1}`, ...data };
      evidence.push(row);
      return { id: row.id, type: row.type, capturedAt: row.capturedAt };
    },
    findMany: async ({ where }: { where: { attemptId: string; assessmentId: string } }) =>
      evidence
        .filter((e) => e.attemptId === where.attemptId && e.assessmentId === where.assessmentId)
        .sort((x, y) => +x.capturedAt - +y.capturedAt)
        .map((e) => ({ id: e.id, type: e.type, capturedAt: e.capturedAt, fileSize: e.fileSize })),
    groupBy: async ({ where }: { where: { assessmentId: string; attemptId: { in: string[] } } }) => {
      const counts = new Map<string, number>();
      for (const e of evidence.filter((x) => x.assessmentId === where.assessmentId && where.attemptId.in.includes(x.attemptId))) counts.set(e.attemptId, (counts.get(e.attemptId) ?? 0) + 1);
      return [...counts].map(([attemptId, n]) => ({ attemptId, _count: { _all: n } }));
    },
  },
};

vi.mock("@/server/db", () => ({ db: fakeDb }));
vi.mock("@/server/storage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  evidenceStorage: () => fakeStore,
  evidenceStorageFor: () => fakeStore,
}));
vi.stubEnv("DATABASE_URL", "postgresql://unit:unit@localhost:5432/unit_test");

const { uploadEvidence, listAttemptEvidence, getEvidence, evidenceImage, evidenceCountsByAttempt, EVIDENCE_URL_SECONDS } = await import("@/server/services/proctoring-evidence");
const { recordPresence } = await import("@/server/services/presence");
const { presenceStore } = await import("@/server/realtime/presence");
const { monitoringBus } = await import("@/server/realtime/bus");
const { newEvidenceKey, MemoryStorage } = await import("@/server/storage");
const { ConflictError, ForbiddenError, NotFoundError, ValidationError } = await import("@/lib/errors");

const actor = (id: string) => ({ id, email: `${id}@example.com`, name: id, role: users.get(id)!.role });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const CONN = "11111111-2222-3333-4444-555555555555";

const SETTINGS = {
  status: "ACTIVE",
  timingMode: "FULL_DURATION",
  endAt: new Date("2026-10-26T12:00:00Z"),
  durationMinutes: 60,
  pausedAt: null,
  proctoringEnabled: true,
  focusMonitoringEnabled: true,
  fullscreenEnabled: false,
  clipboardMonitoringEnabled: false,
  cameraRequired: true,
  faceDetectionEnabled: true,
  multipleFaceDetectionEnabled: true,
  faceMissingDetectionEnabled: true,
  cameraSnapshotsEnabled: true,
  screenMonitoringEnabled: true,
};

function addAttempt(id: string, assessmentId: string, learnerId: string, extra: Partial<Attempt> = {}) {
  attempts.set(id, {
    id,
    assessmentId,
    learnerId,
    status: "IN_PROGRESS",
    lockedAt: null,
    startedAt: new Date("2026-10-26T09:30:00Z"),
    deadlineAt: new Date("2026-10-26T10:30:00Z"),
    pausedSeconds: 0,
    extensionSeconds: 0,
    ...extra,
  });
}

/** Events published on the process-wide bus for these assessments while `fn` runs. */
async function captured(assessmentIds: string[], fn: () => unknown) {
  const got: MonitoringEvent[] = [];
  const offs = assessmentIds.map((id) => monitoringBus.subscribe(id, (e) => got.push(e)));
  try {
    await fn();
  } finally {
    for (const off of offs) off();
  }
  return got;
}

beforeEach(() => {
  users.clear();
  assessments.clear();
  proctors.length = 0;
  attempts.clear();
  evidence.length = 0;
  attemptWrites.length = 0;
  objects.clear();
  signed.length = 0;
  failCreate = false;
  signedUrls = true;
  fakeStore.signedUrl = async (key: string, seconds: number) => {
    if (!signedUrls) throw new Error("no signed URLs");
    signed.push(key);
    return `https://storage.example/signed/${key}?expires=${seconds}`;
  };
  presenceStore.clear();
  for (const [id, role] of [
    ["admin", "ADMIN"],
    ["pat", "REVIEWER"],
    ["quinn", "REVIEWER"],
    ["eve", "EXAMINER"],
    ["lina", "LEARNER"],
    ["leo", "LEARNER"],
    ["mia", "LEARNER"],
  ] as const)
    users.set(id, { id, role, status: "ACTIVE" });
  assessments.set("exam-A", { id: "exam-A", ...SETTINGS });
  assessments.set("exam-B", { id: "exam-B", ...SETTINGS });
  proctors.push({ assessmentId: "exam-A", proctorId: "pat" }, { assessmentId: "exam-B", proctorId: "quinn" });
  addAttempt("att-lina", "exam-A", "lina");
  addAttempt("att-leo", "exam-A", "leo");
  addAttempt("att-mia", "exam-B", "mia");
});
afterEach(() => presenceStore.clear());

// ---------------------------------------------------------------------------
// Browser-side state
// ---------------------------------------------------------------------------

describe("face state (in-browser detection, debounced)", () => {
  const face = (score = 0.9, width = 0.3) => ({ score, width });
  function setup() {
    const reports: FaceReport[] = [];
    const backs: string[] = [];
    const monitor = createFaceMonitor({
      isIdle: () => false,
      events: { missing: true, multiple: true },
      report: (r) => reports.push(r),
      departures: { leave: () => "incident-0001", back: (s) => void backs.push(s) },
      newId: () => "incident-0002",
    });
    let t = 0;
    const run = (ms: number, faces: { score: number; width: number }[]) => {
      let status = monitor.status();
      for (const end = t + ms; t < end; t += FACE_RULES.sampleMs) status = monitor.sample(t, { faces });
      return status;
    };
    return { reports, backs, run };
  }

  it("one face: normal (ONE_FACE), nothing reported", () => {
    const { reports, run } = setup();
    expect(run(30_000, [face()])).toBe("detected");
    expect(reports).toEqual([]);
  });

  it("no face: a notice first, FACE_NOT_DETECTED only after the grace period, and only once", () => {
    const { reports, run } = setup();
    run(1_000, [face()]);
    expect(run(FACE_RULES.missingNoticeMs + 500, [])).toBe("missing"); // shown to the learner…
    expect(reports).toEqual([]); // …but not reported yet
    run(FACE_RULES.missingReportMs - FACE_RULES.missingNoticeMs, []);
    expect(reports.map((r) => r.eventType)).toEqual(["FACE_NOT_DETECTED"]);
    run(60_000, []); // still absent: the same episode, no repeat every frame
    expect(reports).toHaveLength(1);
  });

  it("a short absence (under the grace period) is never reported (debounce)", () => {
    const { reports, run } = setup();
    for (let i = 0; i < 5; i++) {
      run(FACE_RULES.missingReportMs - 2_000, []);
      run(2_000, [face()]);
    }
    expect(reports).toEqual([]);
  });

  it("multiple faces: reported only when they persist, then recovery ends the episode", () => {
    const { reports, backs, run } = setup();
    run(1_000, [face(), face(0.5)]); // a weak second face doesn't count
    run(1_000, [face(), face(0.9)]); // a brief second face isn't enough
    run(1_000, [face()]);
    expect(reports).toEqual([]);
    expect(run(FACE_RULES.multipleWindowMs + 1_000, [face(), face(0.9)])).toBe("multiple");
    expect(reports.map((r) => r.eventType)).toEqual(["MULTIPLE_FACES"]);
    expect(run(FACE_RULES.clearMs + 1_000, [face()])).toBe("detected"); // recovery
    expect(backs).toEqual([]); // (a multiple-face episode isn't a departure)
  });

  it("recovery after a missing face: back to one face, the departure ends", () => {
    const { backs, run } = setup();
    run(FACE_RULES.missingReportMs + 1_000, []);
    expect(run(FACE_RULES.clearMs + 1_000, [face()])).toBe("detected");
    expect(backs).toEqual(["face"]);
  });
});

describe("camera state", () => {
  it("permission denied (at the prompt, or revoked later) is recognised", () => {
    expect(cameraProblem({ name: "NotAllowedError" })).toBe("denied");
    expect(cameraLossType("denied")).toBe("CAMERA_PERMISSION_REVOKED");
    expect(cameraLossType("granted")).toBe("CAMERA_DISABLED");
  });

  it("a disconnect is reported once; after reconnecting a new loss is reported again", () => {
    const losses: string[] = [];
    const m = createCameraMonitor({ isIdle: () => false, onLoss: (t) => losses.push(t) });
    m.ready();
    expect(m.lost("CAMERA_DISABLED")).toBe(true);
    expect(m.lost("CAMERA_PERMISSION_REVOKED")).toBe(false); // the same loss (track ending after revoke)
    m.ready(); // reconnected
    expect(m.lost("CAMERA_DISABLED")).toBe(true);
    expect(losses).toEqual(["CAMERA_DISABLED", "CAMERA_DISABLED"]);
  });
});

describe("screen sharing state", () => {
  function setup(idle = false) {
    const reports: ScreenEventType[] = [];
    return { reports, m: createScreenMonitor({ isIdle: () => idle, report: (t) => reports.push(t) }) };
  }

  it("permission denied is reported once until sharing starts", () => {
    const { reports, m } = setup();
    expect(screenProblem({ name: "NotAllowedError" })).toBe("denied");
    m.requesting();
    m.denied();
    m.denied();
    expect(reports).toEqual(["SCREEN_SHARE_PERMISSION_DENIED"]);
    expect(m.status()).toBe("denied");
  });

  it("sharing stopped is reported once; reconnecting reports a new start; stopping again is reported again", () => {
    const { reports, m } = setup();
    m.started();
    m.started(); // already sharing: nothing
    m.stopped();
    m.stopped();
    expect(m.status()).toBe("stopped");
    m.started(); // reconnect
    m.stopped();
    expect(reports).toEqual(["SCREEN_SHARE_STARTED", "SCREEN_SHARE_STOPPED", "SCREEN_SHARE_STARTED", "SCREEN_SHARE_STOPPED"]);
  });

  it("nothing is reported while idle (paused, locked, closing); only the entire screen is accepted", () => {
    const { reports, m } = setup(true);
    m.started();
    m.stopped();
    expect(reports).toEqual([]);
    expect(sharedSurfaceOk({ displaySurface: "monitor" })).toBe(true);
    expect(sharedSurfaceOk({ displaySurface: "window" })).toBe(false);
    expect(sharedSurfaceOk({ displaySurface: "browser" })).toBe(false);
    expect(sharedSurfaceOk({})).toBe(true); // the browser doesn't say
    expect([screenStateOf("sharing"), screenStateOf("stopped"), screenStateOf("denied"), screenStateOf("not-requested")]).toEqual(["sharing", "stopped", "denied", null]);
  });
});

describe("randomized snapshot scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("each delay is within [min, max] — the extremes included — and varies with the random source", () => {
    expect(nextSnapshotDelay(() => 0)).toBe(SNAPSHOT_WINDOW.minMs);
    expect(nextSnapshotDelay(() => 0.9999999)).toBe(SNAPSHOT_WINDOW.maxMs);
    const delays = new Set(Array.from({ length: 200 }, () => nextSnapshotDelay()));
    expect(delays.size).toBeGreaterThan(50); // not a fixed interval
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(SNAPSHOT_WINDOW.minMs);
      expect(d).toBeLessThanOrEqual(SNAPSHOT_WINDOW.maxMs);
    }
    expect(SNAPSHOT_WINDOW).toEqual({ minMs: 180_000, maxMs: 300_000 });
  });

  it("no capture straight after start (e.g. a reload) or before the minimum; one by the maximum", async () => {
    let captures = 0;
    const s = createSnapshotScheduler({ canCapture: () => true, capture: async () => void captures++ });
    s.start();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WINDOW.minMs - 1);
    expect(captures).toBe(0);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WINDOW.maxMs - SNAPSHOT_WINDOW.minMs + 1);
    expect(captures).toBe(1);
    s.stop();
  });

  it("no duplicate captures: one timer, one capture in flight, start is idempotent", async () => {
    let captures = 0;
    let release: () => void = () => {};
    const s = createSnapshotScheduler({
      canCapture: () => true,
      random: () => 0,
      capture: () => {
        captures++;
        return new Promise<void>((r) => (release = r));
      },
    });
    s.start();
    s.start();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WINDOW.minMs);
    expect(captures).toBe(1);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WINDOW.minMs * 3); // the first is still uploading
    expect(captures).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WINDOW.minMs);
    expect(captures).toBe(2);
    s.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("no capture while the camera / screen is unavailable: that slot is skipped, the next is scheduled", async () => {
    let available = false;
    let captures = 0;
    const s = createSnapshotScheduler({ canCapture: () => available, random: () => 0, capture: async () => void captures++ });
    s.start();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WINDOW.minMs * 3);
    expect(captures).toBe(0);
    expect(s.scheduled()).toBe(true);
    available = true;
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WINDOW.minMs);
    expect(captures).toBe(1);
    s.stop();
  });

  it("a failing capture never breaks the schedule", async () => {
    let captures = 0;
    const s = createSnapshotScheduler({
      canCapture: () => true,
      random: () => 0,
      capture: async () => {
        captures++;
        throw new Error("upload failed");
      },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WINDOW.minMs * 2);
    expect(captures).toBe(2);
    s.stop();
  });

  it("camera and screen schedules are independent (they don't capture in lockstep)", () => {
    const seq = [0.1, 0.8, 0.5, 0.2];
    let i = 0;
    const rand = () => seq[i++ % seq.length];
    const camera = [nextSnapshotDelay(rand), nextSnapshotDelay(rand)];
    const screen = [nextSnapshotDelay(rand), nextSnapshotDelay(rand)];
    expect(camera).not.toEqual(screen);
  });
});

describe("snapshot images", () => {
  it("are scaled down to the evidence size, never up; only JPEGs are accepted", () => {
    expect(fitWithin(1920, 1080, 1280, 800)).toEqual({ width: 1280, height: 720 });
    expect(fitWithin(1280, 1024, 640, 480)).toEqual({ width: 600, height: 480 });
    expect(fitWithin(320, 240, 640, 480)).toEqual({ width: 320, height: 240 });
    expect(looksLikeJpeg(JPEG)).toBe(true);
    expect(looksLikeJpeg(Buffer.from("%PDF-1.7"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Evidence: writing (learner) and reading (proctor)
// ---------------------------------------------------------------------------

describe("storing evidence (learner, own running attempt only)", () => {
  it("camera evidence: metadata from the server, the image in private storage under the attempt, a live event for its assessment only", async () => {
    const events = await captured(["exam-A", "exam-B"], async () => {
      const e = await uploadEvidence(actor("lina"), "att-lina", "CAMERA", JPEG, NOW);
      expect(e).toEqual({ id: "ev-1", type: "CAMERA", capturedAt: NOW });
    });
    expect(evidence).toHaveLength(1);
    const row = evidence[0];
    expect(row).toMatchObject({ assessmentId: "exam-A", attemptId: "att-lina", type: "CAMERA", mimeType: "image/jpeg", fileSize: JPEG.length, capturedAt: NOW, storageDriver: "memory" });
    expect(row.storagePath).toMatch(/^proctoring\/assessment\/exam-A\/attempt\/att-lina\/camera\/[0-9a-f-]{36}\.jpg$/);
    expect(objects.get(row.storagePath)).toMatchObject({ contentType: "image/jpeg" });
    expect(events).toEqual([{ type: "PROCTORING_EVIDENCE_AVAILABLE", assessmentId: "exam-A", attemptId: "att-lina", at: NOW.toISOString(), evidenceId: "ev-1", evidenceType: "CAMERA" }]);
    expect(JSON.stringify(events)).not.toMatch(/proctoring\/|signed|http|lina@/); // no path, URL or learner details
    expect(attemptWrites).toEqual([]); // the attempt itself is never touched (no lock, timing or status change)
  });

  it("screen evidence goes under screen/", async () => {
    await uploadEvidence(actor("lina"), "att-lina", "SCREEN", JPEG, NOW);
    expect(evidence[0].storagePath).toMatch(/\/attempt\/att-lina\/screen\/[0-9a-f-]{36}\.jpg$/);
  });

  it("another learner's attempt: not found — nothing stored, nothing published", async () => {
    const events = await captured(["exam-A", "exam-B"], async () => {
      await expect(uploadEvidence(actor("lina"), "att-leo", "CAMERA", JPEG, NOW)).rejects.toBeInstanceOf(NotFoundError);
      await expect(uploadEvidence(actor("lina"), "att-mia", "SCREEN", JPEG, NOW)).rejects.toBeInstanceOf(NotFoundError);
      await expect(uploadEvidence(actor("lina"), "made-up", "CAMERA", JPEG, NOW)).rejects.toBeInstanceOf(NotFoundError);
    });
    expect(events).toEqual([]);
    expect(evidence).toEqual([]);
    expect(objects.size).toBe(0);
  });

  it("an ended, locked or expired attempt can't store evidence", async () => {
    attempts.get("att-lina")!.status = "SUBMITTED";
    await expect(uploadEvidence(actor("lina"), "att-lina", "CAMERA", JPEG, NOW)).rejects.toBeInstanceOf(ConflictError);
    attempts.get("att-lina")!.status = "IN_PROGRESS";
    attempts.get("att-lina")!.lockedAt = new Date("2026-10-26T09:50:00Z");
    await expect(uploadEvidence(actor("lina"), "att-lina", "CAMERA", JPEG, NOW)).rejects.toBeInstanceOf(ConflictError);
    attempts.get("att-lina")!.lockedAt = null;
    await expect(uploadEvidence(actor("lina"), "att-lina", "CAMERA", JPEG, new Date("2026-10-26T10:31:00Z"))).rejects.toBeInstanceOf(ConflictError);
    expect(objects.size).toBe(0);
  });

  it("only the kinds of evidence switched on for the assessment are accepted", async () => {
    Object.assign(assessments.get("exam-A")!, { cameraSnapshotsEnabled: false });
    await expect(uploadEvidence(actor("lina"), "att-lina", "CAMERA", JPEG, NOW)).rejects.toBeInstanceOf(ConflictError);
    Object.assign(assessments.get("exam-A")!, { cameraSnapshotsEnabled: true, cameraRequired: false });
    await expect(uploadEvidence(actor("lina"), "att-lina", "CAMERA", JPEG, NOW)).rejects.toBeInstanceOf(ConflictError);
    Object.assign(assessments.get("exam-A")!, { screenMonitoringEnabled: false });
    await expect(uploadEvidence(actor("lina"), "att-lina", "SCREEN", JPEG, NOW)).rejects.toBeInstanceOf(ConflictError);
    expect(objects.size).toBe(0);
  });

  it("staff can't store evidence; bad types, non-images and oversized images are refused", async () => {
    for (const who of ["admin", "pat", "eve"]) await expect(uploadEvidence(actor(who), "att-lina", "CAMERA", JPEG, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uploadEvidence(actor("lina"), "att-lina", "VIDEO", JPEG, NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(uploadEvidence(actor("lina"), "att-lina", "CAMERA", Buffer.from("<svg onload=alert(1)>"), NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(uploadEvidence(actor("lina"), "att-lina", "CAMERA", Buffer.concat([JPEG, Buffer.alloc(1_000_001)]), NOW)).rejects.toBeInstanceOf(ValidationError);
    expect(objects.size).toBe(0);
  });

  it("at most one snapshot per type per minute (no flooding); the other type is independent", async () => {
    await uploadEvidence(actor("lina"), "att-lina", "CAMERA", JPEG, NOW);
    await expect(uploadEvidence(actor("lina"), "att-lina", "CAMERA", JPEG, new Date(NOW.getTime() + 30_000))).rejects.toBeInstanceOf(ConflictError);
    await uploadEvidence(actor("lina"), "att-lina", "SCREEN", JPEG, new Date(NOW.getTime() + 30_000));
    await uploadEvidence(actor("lina"), "att-lina", "CAMERA", JPEG, new Date(NOW.getTime() + EVIDENCE_MIN_GAP_MS));
    expect(evidence.map((e) => e.type)).toEqual(["CAMERA", "SCREEN", "CAMERA"]);
  });

  it("if the metadata can't be saved, the stored image is removed and nothing is published", async () => {
    failCreate = true;
    const events = await captured(["exam-A"], () => expect(uploadEvidence(actor("lina"), "att-lina", "CAMERA", JPEG, NOW)).rejects.toThrow("database unavailable"));
    expect(objects.size).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("reading evidence (administrator, or a proctor assigned to the assessment)", () => {
  beforeEach(async () => {
    await uploadEvidence(actor("lina"), "att-lina", "CAMERA", JPEG, NOW);
    await uploadEvidence(actor("lina"), "att-lina", "SCREEN", JPEG, new Date(NOW.getTime() + 1_000));
    await uploadEvidence(actor("mia"), "att-mia", "CAMERA", JPEG, NOW);
  });

  it("an assigned proctor and an administrator see the attempt's evidence (metadata only)", async () => {
    for (const who of ["pat", "admin"]) {
      const list = await listAttemptEvidence(actor(who), "exam-A", "att-lina");
      expect(list.map((e) => e.type)).toEqual(["CAMERA", "SCREEN"]);
      expect(Object.keys(list[0]).sort()).toEqual(["capturedAt", "fileSize", "id", "type"]); // no storage path
    }
    expect(await evidenceCountsByAttempt("exam-A", ["att-lina", "att-leo"])).toEqual(new Map([["att-lina", 2]]));
  });

  it("learners and examiners can't read evidence; an unassigned proctor gets \"not found\"", async () => {
    for (const who of ["lina", "eve"]) {
      await expect(listAttemptEvidence(actor(who), "exam-A", "att-lina")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(evidenceImage(actor(who), "exam-A", "att-lina", "ev-1")).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(listAttemptEvidence(actor("quinn"), "exam-A", "att-lina")).rejects.toBeInstanceOf(NotFoundError);
    await expect(evidenceImage(actor("quinn"), "exam-A", "att-lina", "ev-1")).rejects.toBeInstanceOf(NotFoundError);
    users.get("pat")!.status = "DISABLED";
    await expect(evidenceImage(actor("pat"), "exam-A", "att-lina", "ev-1")).rejects.toBeInstanceOf(NotFoundError);
    expect(signed).toEqual([]); // no URL was made for anyone refused
  });

  it("assessment A's evidence can't be reached through assessment B, nor another attempt's through this one", async () => {
    // Quinn proctors B; Lina's attempt is in A.
    await expect(listAttemptEvidence(actor("quinn"), "exam-B", "att-lina")).rejects.toBeInstanceOf(NotFoundError);
    await expect(evidenceImage(actor("quinn"), "exam-B", "att-lina", "ev-1")).rejects.toBeInstanceOf(NotFoundError);
    await expect(evidenceImage(actor("admin"), "exam-B", "att-lina", "ev-1")).rejects.toBeInstanceOf(NotFoundError);
    // Mia's evidence (ev-3, exam B) through Lina's attempt, or through exam A:
    await expect(evidenceImage(actor("pat"), "exam-A", "att-lina", "ev-3")).rejects.toBeInstanceOf(NotFoundError);
    await expect(getEvidence(actor("admin"), "exam-A", "att-lina", "ev-3")).rejects.toBeInstanceOf(NotFoundError);
    expect(signed).toEqual([]);
  });

  it("guessed evidence ids expose nothing", async () => {
    for (const id of ["ev-99", "", "../ev-1", "ev-1' OR 1=1"]) await expect(evidenceImage(actor("admin"), "exam-A", "att-lina", id)).rejects.toBeInstanceOf(NotFoundError);
    expect(signed).toEqual([]);
  });

  it("the image: a signed URL valid for a minute, made only after authorization; or the bytes from the app", async () => {
    const r = await evidenceImage(actor("pat"), "exam-A", "att-lina", "ev-1");
    expect(r).toEqual({ url: `https://storage.example/signed/${evidence[0].storagePath}?expires=${EVIDENCE_URL_SECONDS}` });
    expect(EVIDENCE_URL_SECONDS).toBeLessThanOrEqual(60);
    fakeStore.signedUrl = undefined;
    const bytes = await evidenceImage(actor("pat"), "exam-A", "att-lina", "ev-1");
    expect("data" in bytes && Buffer.compare(bytes.data, JPEG)).toBe(0);
  });

  it("the viewer gets its neighbours within the same attempt only", async () => {
    const v = await getEvidence(actor("pat"), "exam-A", "att-lina", "ev-1");
    expect(v).toMatchObject({ position: 1, total: 2, previousId: null, nextId: "ev-2" });
  });
});

describe("evidence storage keys", () => {
  it("are generated from the database ids, under the attempt; anything else is refused", async () => {
    expect(newEvidenceKey("exam-A", "att-lina", "camera")).toMatch(/^proctoring\/assessment\/exam-A\/attempt\/att-lina\/camera\/[0-9a-f-]{36}\.jpg$/);
    expect(() => newEvidenceKey("../x", "att", "camera")).toThrow();
    expect(() => newEvidenceKey("exam-A", "att/../../x", "screen")).toThrow();
    const store = new MemoryStorage();
    await expect(store.put("proctoring/assessment/a/attempt/b/video/x.jpg", JPEG)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Live status and events
// ---------------------------------------------------------------------------

describe("camera / face / screen status for the proctor", () => {
  const status = (camera: "on" | "off" | "denied" | null, face: "one" | "none" | "multiple" | null, screen: "sharing" | "stopped" | "denied" | null) => ({ camera, face, screen });

  it("a change of state publishes PROCTORING_STATUS_CHANGED once; the same state publishes nothing", async () => {
    const events = await captured(["exam-A", "exam-B"], async () => {
      await recordPresence(actor("lina"), "att-lina", CONN, NOW, status("on", "one", "sharing")); // comes online
      await recordPresence(actor("lina"), "att-lina", CONN, NOW, status("on", "one", "sharing"));
      await recordPresence(actor("lina"), "att-lina", CONN, NOW, status("on", "multiple", "stopped"));
      await recordPresence(actor("lina"), "att-lina", CONN, NOW, status("on", "multiple", "stopped"));
    });
    expect(events.map((e) => `${e.type}:${e.assessmentId}`)).toEqual(["LEARNER_ONLINE:exam-A", "PROCTORING_STATUS_CHANGED:exam-A"]);
    expect(presenceStore.get("att-lina")!.status).toEqual(status("on", "multiple", "stopped"));
  });

  it("a malformed status, or someone else's attempt, is refused and publishes nothing", async () => {
    const events = await captured(["exam-A", "exam-B"], async () => {
      await expect(recordPresence(actor("lina"), "att-lina", CONN, NOW, { camera: "hacked", face: null, screen: null })).rejects.toBeInstanceOf(ValidationError);
      await expect(recordPresence(actor("lina"), "att-lina", CONN, NOW, { camera: "on", face: "one", screen: "sharing", extra: 1 })).rejects.toBeInstanceOf(ValidationError);
      await expect(recordPresence(actor("lina"), "att-mia", CONN, NOW, status("on", "one", null))).rejects.toBeInstanceOf(NotFoundError);
    });
    expect(events).toEqual([]);
    expect(parseMonitoringStatus({ camera: "on", face: "none", screen: null })).toEqual(status("on", "none", null));
    expect(parseMonitoringStatus([])).toBeNull();
  });

  it("status changes and evidence reach only the stream of the attempt's assessment", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    try {
      const abort = new AbortController();
      const read = (assessmentId: string) => {
        const reader = createMonitoringStream({ assessmentId, bus: monitoringBus, signal: abort.signal, recheck: async () => true }).getReader();
        let text = "";
        void (async () => {
          for (;;) {
            const r = await reader.read();
            if (r.done) return;
            text += new TextDecoder().decode(r.value);
          }
        })();
        return () => text;
      };
      const a = read("exam-A");
      const b = read("exam-B");
      await vi.advanceTimersByTimeAsync(0);
      await uploadEvidence(actor("lina"), "att-lina", "SCREEN", JPEG, NOW);
      await vi.advanceTimersByTimeAsync(0);
      expect(a()).toContain("event: PROCTORING_EVIDENCE_AVAILABLE\ndata: ");
      expect(a()).toContain('"evidenceType":"SCREEN"');
      expect(b()).not.toContain("PROCTORING_EVIDENCE_AVAILABLE");
      expect(a()).not.toMatch(/proctoring\/assessment|signed|base64/); // no image, path or URL on the stream
      abort.abort();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a presence store keeps the last status per attempt, apart per assessment", () => {
    const bus = createMonitoringBus();
    const store = createPresenceStore({ bus, clock: () => 1_000 });
    store.heartbeat({ attemptId: "t1", assessmentId: "A", learnerId: "l1", connectionId: CONN }, status("off", null, null));
    store.heartbeat({ attemptId: "t2", assessmentId: "B", learnerId: "l2", connectionId: CONN }, status("on", "one", "sharing"));
    expect(store.get("t1")!.status.camera).toBe("off");
    expect(store.get("t2")!.status.screen).toBe("sharing");
    store.clear();
  });
});

// ---------------------------------------------------------------------------
// Configuration and exam robustness
// ---------------------------------------------------------------------------

describe("configuration", () => {
  const OFF: ProctoringSettings = {
    proctoringEnabled: false,
    focusMonitoringEnabled: false,
    fullscreenEnabled: false,
    clipboardMonitoringEnabled: false,
    cameraRequired: false,
    faceDetectionEnabled: false,
    multipleFaceDetectionEnabled: false,
    faceMissingDetectionEnabled: false,
    cameraSnapshotsEnabled: false,
    screenMonitoringEnabled: false,
  };

  it("evidence is off unless switched on; camera snapshots need the camera; screen monitoring needs proctoring", () => {
    expect(effectiveProctoring(OFF)).toMatchObject({ cameraSnapshots: false, screen: false });
    expect(effectiveProctoring({ ...OFF, proctoringEnabled: true, cameraSnapshotsEnabled: true })).toMatchObject({ cameraSnapshots: false });
    expect(effectiveProctoring({ ...OFF, proctoringEnabled: true, cameraRequired: true, cameraSnapshotsEnabled: true })).toMatchObject({ cameraSnapshots: true });
    expect(effectiveProctoring({ ...OFF, screenMonitoringEnabled: true })).toMatchObject({ screen: false });
    expect(learnerScreenConfig({ ...OFF, proctoringEnabled: true, screenMonitoringEnabled: true })).toEqual({ snapshots: true });
    expect(learnerCameraConfig({ ...OFF, proctoringEnabled: true, cameraRequired: true, cameraSnapshotsEnabled: true, focusMaxViolations: 3, focusViolationAction: "WARN" })).toMatchObject({ snapshots: true });
  });

  it("camera / face / screen observations are recorded but never counted; only focus, fullscreen and clipboard count", () => {
    for (const t of ["CAMERA_CONNECTED", "SCREEN_SHARE_STARTED", "SCREEN_SHARE_STOPPED", "SCREEN_SHARE_PERMISSION_DENIED", "CAMERA_DISABLED", "CAMERA_PERMISSION_REVOKED", "FACE_NOT_DETECTED", "MULTIPLE_FACES"] as const)
      expect(isViolation(t)).toBe(false);
    for (const t of ["FOCUS_LOST", "FULLSCREEN_EXIT", "CLIPBOARD_COPY", "CLIPBOARD_CUT", "CLIPBOARD_PASTE"] as const) expect(isViolation(t)).toBe(true);
    expect(isViolation("PROCTORING_STARTED")).toBe(false);
    const p = effectiveProctoring({ ...OFF, proctoringEnabled: true, screenMonitoringEnabled: true });
    expect(eventEnabled("SCREEN_SHARE_STOPPED", p)).toBe(true);
    expect(eventEnabled("CAMERA_CONNECTED", p)).toBe(false);
    expect(eventSeverity("SCREEN_SHARE_STOPPED", null)).toBe("MEDIUM");
    expect(eventSeverity("SCREEN_SHARE_STARTED", null)).toBe("LOW");
  });

  it("the evidence storage origin is allowed for images on proctor pages only", () => {
    expect(allowsEvidenceImages("/proctor/assessments/a/attempts/b")).toBe(true);
    expect(allowsEvidenceImages("/learner/assessment/a")).toBe(false);
    expect(originOf("https://proj.supabase.co/storage/v1")).toBe("https://proj.supabase.co");
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(contentSecurityPolicy({ nonce: "n", dev: false, upgradeInsecure: true, imageOrigin: "https://proj.supabase.co" })).toContain("img-src 'self' data: blob: https://proj.supabase.co;");
    expect(contentSecurityPolicy({ nonce: "n", dev: false, upgradeInsecure: true })).toContain("img-src 'self' data: blob:;");
  });
});

describe("exam robustness", () => {
  it("an upload failure is retried once and then dropped — it never throws into the exam", async () => {
    let calls = 0;
    const offline = (async () => {
      calls++;
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(uploadSnapshot("att-lina", "CAMERA", new Blob([JPEG]), { fetch: offline, sleep: async () => {} })).resolves.toBe("failed");
    expect(calls).toBe(2);
    calls = 0;
    const serverError = (async () => (calls++, new Response("{}", { status: 503 }))) as unknown as typeof fetch;
    await expect(uploadSnapshot("att-lina", "SCREEN", new Blob([JPEG]), { fetch: serverError, sleep: async () => {} })).resolves.toBe("failed");
    expect(calls).toBe(2);
  });

  it("a refusal isn't retried; success is reported; the retry is skipped once the exam has stopped", async () => {
    let calls = 0;
    const refused = (async () => (calls++, new Response("{}", { status: 409 }))) as unknown as typeof fetch;
    await expect(uploadSnapshot("att-lina", "CAMERA", new Blob([JPEG]), { fetch: refused, sleep: async () => {} })).resolves.toBe("refused");
    expect(calls).toBe(1);
    const ok = (async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/attempts/att-lina/evidence");
      expect((init.body as FormData).get("type")).toBe("CAMERA");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(uploadSnapshot("att-lina", "CAMERA", new Blob([JPEG]), { fetch: ok })).resolves.toBe("stored");
    calls = 0;
    const offline = (async () => (calls++, Promise.reject(new TypeError("offline")))) as unknown as typeof fetch;
    await expect(uploadSnapshot("att-lina", "CAMERA", new Blob([JPEG]), { fetch: offline, sleep: async () => {}, stopped: () => true })).resolves.toBe("failed");
    expect(calls).toBe(1);
  });

  it("an evidence failure leaves the attempt untouched (still in progress, no lock, no termination)", async () => {
    failCreate = true;
    await expect(uploadEvidence(actor("lina"), "att-lina", "CAMERA", JPEG, NOW)).rejects.toThrow();
    expect(attempts.get("att-lina")).toMatchObject({ status: "IN_PROGRESS", lockedAt: null });
    expect(attemptWrites).toEqual([]);
  });
});

describe("credentials never reach the browser", () => {
  const ROOT = path.resolve(__dirname, "../../src");
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  }

  it("no client module (\"use client\") imports server storage or reads the service-role key", () => {
    const clientFiles = files(ROOT).filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    expect(clientFiles.length).toBeGreaterThan(5);
    for (const f of clientFiles) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/@\/server\/storage|SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE/);
    }
    // The evidence modules the exam page uses directly are browser-safe too.
    for (const f of ["lib/proctoring/evidence.ts", "lib/proctoring/evidence-upload.ts", "lib/proctoring/snapshot-schedule.ts", "lib/proctoring/screen-monitor.ts", "lib/proctoring/monitoring-status.ts"]) {
      expect(readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(/@\/server\/|process\.env|SERVICE_ROLE/);
    }
  });
});
