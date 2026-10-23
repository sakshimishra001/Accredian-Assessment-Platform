import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitoringEvent } from "@/lib/proctoring/monitoring-events";
import { createMonitoringBus } from "@/server/realtime/bus";
import { createPresenceStore, PRESENCE_HEARTBEAT_MS, PRESENCE_OFFLINE_AFTER_MS } from "@/server/realtime/presence";
import { createMonitoringStream } from "@/server/realtime/sse";

/*
 * Proctor dashboard, phase 6: learner presence. The in-memory store (with a fake clock), the
 * learner's heartbeat service against an in-memory stand-in for the database, and presence events
 * on the proctor's live stream. Presence is connection status only — never a violation.
 */

const NOW = new Date("2026-10-22T10:00:00Z");
type Attempt = { id: string; assessmentId: string; learnerId: string; status: string; lockedAt: Date | null; startedAt: Date; deadlineAt: Date; pausedSeconds: number; extensionSeconds: number; assessment: Record<string, unknown> };
const attempts: Attempt[] = [];
const writes: string[] = [];
const write = (model: string) => async () => {
  writes.push(model);
  throw new Error(`unexpected write to ${model}`);
};

const fakeDb = {
  assessmentAttempt: {
    findFirst: async ({ where }: { where: { id: string; learnerId: string } }) => attempts.find((t) => t.id === where.id && t.learnerId === where.learnerId) ?? null,
    update: write("assessmentAttempt"),
    updateMany: write("assessmentAttempt"),
  },
  proctoringEvent: { create: write("proctoringEvent") },
};
vi.mock("@/server/db", () => ({ db: fakeDb }));
vi.stubEnv("DATABASE_URL", "postgresql://unit:unit@localhost:5432/unit_test");

const { recordPresence, leavePresence, presenceOf } = await import("@/server/services/presence");
const { presenceStore } = await import("@/server/realtime/presence");
const { monitoringBus } = await import("@/server/realtime/bus");
const { emitMonitoringEvent } = await import("@/server/realtime/publish");
const { ConflictError, ForbiddenError, NotFoundError, ValidationError } = await import("@/lib/errors");

const learner = (id: string) => ({ id, email: `${id}@example.com`, name: id, role: "LEARNER" as const });
const staff = (id: string, role: "ADMIN" | "EXAMINER" | "REVIEWER") => ({ id, email: `${id}@example.com`, name: id, role });
const CONN = "11111111-2222-3333-4444-555555555555";
const CONN2 = "66666666-7777-8888-9999-000000000000";

function addAttempt(id: string, assessmentId: string, learnerId: string, extra: Partial<Attempt> = {}, assessment: Record<string, unknown> = {}) {
  attempts.push({
    id,
    assessmentId,
    learnerId,
    status: "IN_PROGRESS",
    lockedAt: null,
    startedAt: new Date("2026-10-22T09:30:00Z"),
    deadlineAt: new Date("2026-10-22T10:30:00Z"),
    pausedSeconds: 0,
    extensionSeconds: 0,
    ...extra,
    assessment: { status: "ACTIVE", timingMode: "FULL_DURATION", endAt: new Date("2026-10-22T12:00:00Z"), durationMinutes: 60, pausedAt: null, ...assessment },
  });
}

/** Events published on the process-wide bus for one assessment while `fn` runs. */
async function captured(assessmentId: string, fn: () => unknown) {
  const got: MonitoringEvent[] = [];
  const off = monitoringBus.subscribe(assessmentId, (e) => got.push(e));
  try {
    await fn();
  } finally {
    off();
  }
  return got;
}

beforeEach(() => {
  attempts.length = 0;
  writes.length = 0;
  presenceStore.clear();
  addAttempt("att-lina", "exam-A", "lina");
  addAttempt("att-leo", "exam-A", "leo");
  addAttempt("att-mia", "exam-B", "mia");
});
afterEach(() => presenceStore.clear());

describe("presence store", () => {
  function setup(opts: { maxRecords?: number } = {}) {
    let t = 1_000_000;
    const bus = createMonitoringBus();
    const events: MonitoringEvent[] = [];
    bus.subscribe("exam-A", (e) => events.push(e));
    bus.subscribe("exam-B", (e) => events.push(e));
    const store = createPresenceStore({ bus, clock: () => t, forgetAfterMs: 10 * 60_000, ...opts });
    const advance = (ms: number) => (t += ms);
    const beat = (attemptId = "att-1", assessmentId = "exam-A", learnerId = "lina", connectionId = CONN) => store.heartbeat({ attemptId, assessmentId, learnerId, connectionId });
    return { store, events, advance, beat, now: () => t };
  }

  it("a heartbeat creates presence; repeated heartbeats update lastSeenAt without a second record", () => {
    const { store, advance, beat, now } = setup();
    expect(store.get("att-1")).toBeNull();
    expect(beat()).toBe(true);
    expect(store.get("att-1")).toEqual({ online: true, lastSeenAt: new Date(now()) });
    advance(PRESENCE_HEARTBEAT_MS);
    beat();
    expect(store.get("att-1")!.lastSeenAt).toEqual(new Date(now()));
    expect(store.size()).toBe(1);
    store.clear();
  });

  it("online within the threshold, offline beyond it; one missed heartbeat doesn't make a learner offline", () => {
    const { store, advance, beat } = setup();
    beat();
    advance(2 * PRESENCE_HEARTBEAT_MS); // a failed heartbeat in between
    expect(store.get("att-1")!.online).toBe(true);
    advance(PRESENCE_OFFLINE_AFTER_MS - 2 * PRESENCE_HEARTBEAT_MS);
    expect(store.get("att-1")!.online).toBe(true); // exactly at the threshold
    advance(1);
    expect(store.get("att-1")!.online).toBe(false); // computed when read, even before a sweep
    store.clear();
  });

  it("stale records are forgotten after the offline threshold plus a grace period; the sweeper stops when empty", () => {
    const { store, advance, beat } = setup();
    beat();
    expect(store.sweeping()).toBe(true);
    advance(PRESENCE_OFFLINE_AFTER_MS + 5 * 60_000);
    store.sweep();
    expect(store.size()).toBe(1); // offline, still "last seen"
    advance(5 * 60_000 + 1);
    store.sweep();
    expect(store.size()).toBe(0);
    expect(store.sweeping()).toBe(false);
  });

  it("attempts and assessments are kept apart", () => {
    const { store, advance, beat } = setup();
    beat("att-1", "exam-A", "lina");
    advance(PRESENCE_OFFLINE_AFTER_MS);
    beat("att-2", "exam-A", "leo");
    beat("att-3", "exam-B", "mia");
    advance(1);
    expect(store.get("att-1")!.online).toBe(false);
    expect(store.get("att-2")!.online).toBe(true);
    expect(store.get("att-3")!.online).toBe(true);
    // A heartbeat claiming another assessment or learner for an existing attempt changes nothing.
    expect(beat("att-1", "exam-B", "lina")).toBe(false);
    expect(beat("att-1", "exam-A", "mia")).toBe(false);
    expect(store.get("att-1")!.online).toBe(false);
    store.clear();
  });

  it("the number of records is capped", () => {
    const { store, beat } = setup({ maxRecords: 2 });
    expect(beat("att-1")).toBe(true);
    expect(beat("att-2")).toBe(true);
    expect(beat("att-3")).toBe(false);
    expect(store.size()).toBe(2);
    store.clear();
  });

  it("first heartbeat publishes LEARNER_ONLINE once; going offline publishes LEARNER_OFFLINE once; coming back publishes ONLINE again", () => {
    const { store, events, advance, beat } = setup();
    beat();
    advance(PRESENCE_HEARTBEAT_MS);
    beat();
    advance(PRESENCE_HEARTBEAT_MS);
    beat();
    expect(events.map((e) => e.type)).toEqual(["LEARNER_ONLINE"]);
    advance(PRESENCE_OFFLINE_AFTER_MS + 1);
    store.sweep();
    store.sweep();
    expect(events.map((e) => e.type)).toEqual(["LEARNER_ONLINE", "LEARNER_OFFLINE"]);
    beat(); // reconnect (e.g. after a refresh): the same record, online again
    expect(events.map((e) => e.type)).toEqual(["LEARNER_ONLINE", "LEARNER_OFFLINE", "LEARNER_ONLINE"]);
    expect(store.size()).toBe(1);
    // Identifiers and a time only.
    expect(Object.keys(events[0]).sort()).toEqual(["assessmentId", "at", "attemptId", "type"]);
    expect(events[0]).toMatchObject({ assessmentId: "exam-A", attemptId: "att-1" });
    store.clear();
  });

  it("the page closing makes the learner offline at once, but a stale page can't override a newer one", () => {
    const { store, events, beat } = setup();
    beat("att-1", "exam-A", "lina", CONN);
    beat("att-1", "exam-A", "lina", CONN2); // reloaded: a new page
    store.leave("att-1", CONN); // the old page's "leaving" arrives late
    expect(store.get("att-1")!.online).toBe(true);
    store.leave("att-1", CONN2);
    expect(store.get("att-1")!.online).toBe(false);
    store.leave("att-1", CONN2); // no second OFFLINE
    expect(events.map((e) => e.type)).toEqual(["LEARNER_ONLINE", "LEARNER_OFFLINE"]);
    store.clear();
  });
});

describe("learner heartbeat authorization", () => {
  it("a learner can heartbeat their own running attempt; nothing is written to the database", async () => {
    const events = await captured("exam-A", () => recordPresence(learner("lina"), "att-lina", CONN, NOW));
    expect(presenceStore.get("att-lina")!.online).toBe(true);
    expect(events.map((e) => [e.type, e.attemptId])).toEqual([["LEARNER_ONLINE", "att-lina"]]);
    expect(writes).toEqual([]); // no proctoring event, violation, timing or lastActivityAt change
  });

  it("repeated heartbeats don't publish ONLINE again", async () => {
    const events = await captured("exam-A", async () => {
      await recordPresence(learner("lina"), "att-lina", CONN, NOW);
      await recordPresence(learner("lina"), "att-lina", CONN, NOW);
      await recordPresence(learner("lina"), "att-lina", CONN, NOW);
    });
    expect(events.map((e) => e.type)).toEqual(["LEARNER_ONLINE"]);
  });

  it("a learner cannot heartbeat another learner's attempt (not found), and nothing is published", async () => {
    const a = await captured("exam-A", () => expect(recordPresence(learner("lina"), "att-leo", CONN, NOW)).rejects.toBeInstanceOf(NotFoundError));
    const b = await captured("exam-B", () => expect(recordPresence(learner("lina"), "att-mia", CONN, NOW)).rejects.toBeInstanceOf(NotFoundError));
    expect([...a, ...b]).toEqual([]);
    expect(presenceStore.size()).toBe(0);
  });

  it("an ended, locked or expired attempt (or one in an ended assessment) cannot heartbeat", async () => {
    attempts.length = 0;
    addAttempt("att-submitted", "exam-A", "lina", { status: "SUBMITTED" });
    addAttempt("att-terminated", "exam-A", "lina", { status: "TERMINATED" });
    addAttempt("att-locked", "exam-A", "lina", { lockedAt: new Date("2026-10-22T09:50:00Z") });
    addAttempt("att-expired", "exam-A", "lina", { deadlineAt: new Date("2026-10-22T09:59:00Z") });
    addAttempt("att-ended-exam", "exam-A", "lina", {}, { status: "ENDED" });
    const events = await captured("exam-A", async () => {
      for (const id of ["att-submitted", "att-terminated", "att-locked", "att-expired", "att-ended-exam"]) {
        await expect(recordPresence(learner("lina"), id, CONN, NOW)).rejects.toBeInstanceOf(ConflictError);
      }
    });
    expect(events).toEqual([]);
    expect(presenceStore.size()).toBe(0);
    expect(writes).toEqual([]); // an expired attempt isn't closed by a heartbeat either
  });

  it("while the assessment is paused the learner is still connected", async () => {
    attempts.length = 0;
    addAttempt("att-paused", "exam-A", "lina", {}, { status: "PAUSED", pausedAt: new Date("2026-10-22T09:55:00Z") });
    await recordPresence(learner("lina"), "att-paused", CONN, NOW);
    expect(presenceStore.get("att-paused")!.online).toBe(true);
  });

  it("staff cannot heartbeat; a malformed connection id is refused; nothing is published", async () => {
    const events = await captured("exam-A", async () => {
      for (const role of ["ADMIN", "EXAMINER", "REVIEWER"] as const) {
        await expect(recordPresence(staff("s", role), "att-lina", CONN, NOW)).rejects.toBeInstanceOf(ForbiddenError);
      }
      await expect(recordPresence(learner("lina"), "att-lina", "<script>", NOW)).rejects.toBeInstanceOf(ValidationError);
      await expect(recordPresence(learner("lina"), "att-lina", undefined, NOW)).rejects.toBeInstanceOf(ValidationError);
    });
    expect(events).toEqual([]);
    expect(presenceStore.size()).toBe(0);
  });

  it("leaving: only for the learner's own attempt", async () => {
    await recordPresence(learner("lina"), "att-lina", CONN, NOW);
    await expect(leavePresence(learner("leo"), "att-lina", CONN)).rejects.toBeInstanceOf(NotFoundError);
    expect(presenceStore.get("att-lina")!.online).toBe(true);
    const events = await captured("exam-A", () => leavePresence(learner("lina"), "att-lina", CONN));
    expect(events.map((e) => e.type)).toEqual(["LEARNER_OFFLINE"]);
    expect(presenceStore.get("att-lina")!.online).toBe(false);
  });

  it("a refresh (new page) re-establishes presence on the same record", async () => {
    await recordPresence(learner("lina"), "att-lina", CONN, NOW);
    await leavePresence(learner("lina"), "att-lina", CONN);
    await recordPresence(learner("lina"), "att-lina", CONN2, NOW);
    expect(presenceStore.get("att-lina")!.online).toBe(true);
    expect(presenceStore.size()).toBe(1);
  });

  it("an attempt that isn't running is never shown online", async () => {
    await recordPresence(learner("lina"), "att-lina", CONN, NOW);
    expect(presenceOf("att-lina", true).online).toBe(true);
    expect(presenceOf("att-lina", false).online).toBe(false);
    expect(presenceOf("att-never-seen", true)).toEqual({ online: false, lastSeenAt: null });
  });

  it("an attempt ending (submit / auto-submit / terminate) forgets its presence; a lock doesn't", async () => {
    await recordPresence(learner("lina"), "att-lina", CONN, NOW);
    await recordPresence(learner("leo"), "att-leo", CONN, NOW);
    emitMonitoringEvent("ATTEMPT_SUBMITTED", "exam-A", "att-lina");
    emitMonitoringEvent("ATTEMPT_LOCKED", "exam-A", "att-leo");
    expect(presenceStore.get("att-lina")).toBeNull();
    expect(presenceStore.get("att-leo")).not.toBeNull();
  });
});

describe("presence events on the proctor's live stream", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  function collector(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    void (async () => {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        text += decoder.decode(r.value);
      }
    })();
    return () => text;
  }

  it("reach the stream of the attempt's assessment only, without learner details", async () => {
    const abort = new AbortController();
    const a = collector(createMonitoringStream({ assessmentId: "exam-A", bus: monitoringBus, signal: abort.signal, recheck: async () => true }));
    const b = collector(createMonitoringStream({ assessmentId: "exam-B", bus: monitoringBus, signal: abort.signal, recheck: async () => true }));
    await vi.advanceTimersByTimeAsync(0);
    await recordPresence(learner("lina"), "att-lina", CONN, NOW);
    await vi.advanceTimersByTimeAsync(0);
    expect(a()).toContain("event: LEARNER_ONLINE\ndata: ");
    expect(a()).toContain('"attemptId":"att-lina"');
    expect(b()).not.toContain("LEARNER_ONLINE");
    expect(a()).not.toMatch(/lina@|"name"|"email"|"learnerId"/);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitoringBus.subscriberCount()).toBe(0);
  });
});
