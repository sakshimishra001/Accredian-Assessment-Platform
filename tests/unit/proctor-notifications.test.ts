import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitoringEvent } from "@/lib/proctoring/monitoring-events";
import {
  canSendNotification,
  checkNotificationMessage,
  dismissNotification,
  MAX_SHOWN_NOTIFICATIONS,
  mergeNotifications,
  NOTIFICATION_MAX_LENGTH,
  notificationPollMs,
  QUICK_NOTIFICATIONS,
  type LearnerNotification,
} from "@/lib/proctoring/notifications";
import { createMonitoringStream } from "@/server/realtime/sse";

/*
 * Proctor dashboard, phase 8: one-way proctor → learner notifications. The real services run against
 * an in-memory stand-in for the database whose queries apply their where-clauses, so scoping mistakes
 * fail here; the live events go through the real buses and SSE stream. No database or browser needed.
 */

const NOW = new Date("2026-10-27T10:00:00Z");
type Role = "ADMIN" | "EXAMINER" | "REVIEWER" | "LEARNER";
const users = new Map<string, { id: string; role: Role; status: string; name: string }>();
const assessments = new Map<string, { id: string; status: string; timingMode: string; endAt: Date; durationMinutes: number; pausedAt: Date | null }>();
const proctors: { assessmentId: string; proctorId: string }[] = [];
type Attempt = { id: string; assessmentId: string; learnerId: string; status: string; startedAt: Date; deadlineAt: Date; pausedSeconds: number; extensionSeconds: number; lockedAt: Date | null; focusViolations: number };
const attempts = new Map<string, Attempt>();
type Note = { id: string; assessmentId: string; attemptId: string; senderUserId: string; message: string; createdAt: Date; readAt: Date | null };
const notes: Note[] = [];
const attemptWrites: string[] = [];

const matches = (n: Note, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => v === undefined || (v === null ? n[k as keyof Note] === null : n[k as keyof Note] === v));

const fakeDb = {
  assessment: { count: async ({ where }: { where: { id: string } }) => (assessments.has(where.id) ? 1 : 0) },
  assessmentProctor: {
    count: async ({ where }: { where: { assessmentId: string; proctorId: string; proctor?: { status: string } } }) =>
      proctors.filter((p) => p.assessmentId === where.assessmentId && p.proctorId === where.proctorId && (!where.proctor || users.get(p.proctorId)?.status === where.proctor.status)).length,
  },
  assessmentAttempt: {
    findFirst: async ({ where }: { where: { id: string; assessmentId?: string; learnerId?: string } }) => {
      const a = attempts.get(where.id);
      if (!a || (where.assessmentId !== undefined && a.assessmentId !== where.assessmentId) || (where.learnerId !== undefined && a.learnerId !== where.learnerId)) return null;
      const learner = users.get(a.learnerId)!;
      return { ...a, learner: { id: learner.id, role: learner.role, name: learner.name }, assessment: assessments.get(a.assessmentId) };
    },
    update: async () => void attemptWrites.push("update"),
    updateMany: async () => (attemptWrites.push("updateMany"), { count: 0 }),
  },
  proctorNotification: {
    count: async ({ where }: { where: Record<string, unknown> }) => notes.filter((n) => matches(n, where)).length,
    create: async ({ data }: { data: Omit<Note, "id" | "readAt"> }) => {
      const n = { id: `note-${notes.length + 1}`, readAt: null, ...data };
      notes.push(n);
      return { id: n.id, createdAt: n.createdAt };
    },
    findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
      const rows = notes
        .filter((n) => matches(n, where))
        .sort((a, b) => +b.createdAt - +a.createdAt || b.id.localeCompare(a.id))
        .map((n) => ({ ...n, sender: { name: users.get(n.senderUserId)!.name, role: users.get(n.senderUserId)!.role } }));
      return take ? rows.slice(0, take) : rows;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => notes.find((n) => matches(n, where)) ?? null,
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Note> }) => {
      const rows = notes.filter((n) => matches(n, where));
      for (const n of rows) Object.assign(n, data);
      return { count: rows.length };
    },
  },
};

vi.mock("@/server/db", () => ({ db: fakeDb }));
vi.stubEnv("DATABASE_URL", "postgresql://unit:unit@localhost:5432/unit_test");

const { sendProctorNotification, listAttemptNotifications, listMyUnreadNotifications, getMyNotification, markNotificationRead, authorizeMyNotificationStream } = await import(
  "@/server/services/proctor-notifications"
);
const { monitoringBus, learnerNotificationBus } = await import("@/server/realtime/bus");
const { ConflictError, ForbiddenError, NotFoundError, ValidationError } = await import("@/lib/errors");

const actor = (id: string) => ({ id, email: `${id}@example.com`, name: users.get(id)!.name, role: users.get(id)!.role });
const send = (who: string, assessmentId: string, attemptId: string, message: unknown = "Please stay on the assessment screen.", now = NOW) =>
  sendProctorNotification(actor(who), { assessmentId, attemptId, message }, now);

/** Events published on a bus for these topics while `fn` runs. */
async function captured(bus: typeof monitoringBus, topics: string[], fn: () => unknown) {
  const got: MonitoringEvent[] = [];
  const offs = topics.map((t) => bus.subscribe(t, (e) => got.push(e)));
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
  notes.length = 0;
  attemptWrites.length = 0;
  for (const [id, role, name] of [
    ["admin", "ADMIN", "Ada Admin"],
    ["pat", "REVIEWER", "Pat Proctor"],
    ["quinn", "REVIEWER", "Quinn"],
    ["eve", "EXAMINER", "Eve"],
    ["lina", "LEARNER", "Lina"],
    ["leo", "LEARNER", "Leo"],
    ["mia", "LEARNER", "Mia"],
  ] as const)
    users.set(id, { id, role, status: "ACTIVE", name });
  for (const id of ["exam-A", "exam-B"]) assessments.set(id, { id, status: "ACTIVE", timingMode: "FULL_DURATION", endAt: new Date("2026-10-27T12:00:00Z"), durationMinutes: 60, pausedAt: null });
  proctors.push({ assessmentId: "exam-A", proctorId: "pat" }, { assessmentId: "exam-B", proctorId: "quinn" });
  const attempt = (id: string, assessmentId: string, learnerId: string, status = "IN_PROGRESS") =>
    attempts.set(id, {
      id,
      assessmentId,
      learnerId,
      status,
      startedAt: new Date("2026-10-27T09:30:00Z"),
      deadlineAt: new Date("2026-10-27T10:30:00Z"),
      pausedSeconds: 0,
      extensionSeconds: 0,
      lockedAt: null,
      focusViolations: 2,
    });
  attempt("att-lina", "exam-A", "lina");
  attempt("att-leo", "exam-A", "leo");
  attempt("att-mia", "exam-B", "mia");
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

describe("who may send", () => {
  it("an administrator can send; an assigned active proctor can send; the message is stored trimmed", async () => {
    expect(await send("admin", "exam-A", "att-lina")).toMatchObject({ learnerName: "Lina" });
    expect(await send("pat", "exam-A", "att-lina", "   Please restore camera access.   ")).toMatchObject({ learnerName: "Lina" });
    expect(notes.map((n) => [n.senderUserId, n.attemptId, n.assessmentId, n.message])).toEqual([
      ["admin", "att-lina", "exam-A", "Please stay on the assessment screen."],
      ["pat", "att-lina", "exam-A", "Please restore camera access."],
    ]);
  });

  it("an unassigned proctor, or a disabled one, is rejected (\"not found\")", async () => {
    await expect(send("quinn", "exam-A", "att-lina")).rejects.toBeInstanceOf(NotFoundError);
    users.get("pat")!.status = "DISABLED";
    await expect(send("pat", "exam-A", "att-lina")).rejects.toBeInstanceOf(NotFoundError);
    expect(notes).toEqual([]);
  });

  it("learners and examiners can't send", async () => {
    await expect(send("lina", "exam-A", "att-lina")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(send("eve", "exam-A", "att-lina")).rejects.toBeInstanceOf(ForbiddenError);
    expect(notes).toEqual([]);
  });

  it("a proctor can't reach an attempt outside their assessment; a mismatched assessment / attempt is rejected", async () => {
    await expect(send("pat", "exam-B", "att-mia")).rejects.toBeInstanceOf(NotFoundError); // not assigned to B
    await expect(send("pat", "exam-A", "att-mia")).rejects.toBeInstanceOf(NotFoundError); // Mia's attempt is in B
    await expect(send("admin", "exam-B", "att-lina")).rejects.toBeInstanceOf(NotFoundError); // Lina's is in A
    await expect(send("admin", "exam-A", "made-up")).rejects.toBeInstanceOf(NotFoundError);
    await expect(send("admin", "exam-A", "")).rejects.toBeInstanceOf(NotFoundError);
    expect(notes).toEqual([]);
  });

  it("only a running attempt: submitted, terminated, auto-submitted or past its deadline is rejected", async () => {
    for (const status of ["SUBMITTED", "TERMINATED", "AUTO_SUBMITTED"]) {
      attempts.get("att-lina")!.status = status;
      await expect(send("pat", "exam-A", "att-lina")).rejects.toBeInstanceOf(ConflictError);
    }
    attempts.get("att-lina")!.status = "IN_PROGRESS";
    await expect(send("pat", "exam-A", "att-lina", "Hello there", new Date("2026-10-27T10:31:00Z"))).rejects.toBeInstanceOf(ConflictError);
    expect(notes).toEqual([]);
  });

  it("the attempt must belong to a learner", async () => {
    users.get("lina")!.role = "EXAMINER";
    await expect(send("pat", "exam-A", "att-lina")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("message validation: trimmed, 3–300 characters, never empty or whitespace only", async () => {
    for (const bad of ["", "    ", "\n\t ", "hi", "  a ", "x".repeat(NOTIFICATION_MAX_LENGTH + 1), 42, null, undefined]) {
      // Straight to the service: the helper's default message would replace undefined.
      await expect(sendProctorNotification(actor("pat"), { assessmentId: "exam-A", attemptId: "att-lina", message: bad }, NOW)).rejects.toBeInstanceOf(ValidationError);
    }
    await send("pat", "exam-A", "att-lina", "abc");
    await send("pat", "exam-A", "att-lina", "x".repeat(NOTIFICATION_MAX_LENGTH));
    expect(notes.map((n) => n.message.length)).toEqual([3, NOTIFICATION_MAX_LENGTH]);
  });

  it("a notification changes nothing about the attempt (no violation, counter, lock, termination, timing)", async () => {
    const before = structuredClone(attempts.get("att-lina"));
    await send("pat", "exam-A", "att-lina");
    expect(attempts.get("att-lina")).toEqual(before);
    expect(attemptWrites).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The learner's reads and acknowledgement
// ---------------------------------------------------------------------------

describe("the learner reads only their own notifications", () => {
  beforeEach(async () => {
    await send("pat", "exam-A", "att-lina", "First message", new Date(NOW.getTime() - 60_000));
    await send("pat", "exam-A", "att-lina", "Second message", NOW);
    await send("pat", "exam-A", "att-leo", "For Leo only", NOW);
  });

  it("their unread ones, oldest first — text and time only (no sender, no attempt or assessment)", async () => {
    const list = await listMyUnreadNotifications(actor("lina"), "att-lina");
    expect(list.map((n) => n.message)).toEqual(["First message", "Second message"]);
    expect(Object.keys(list[0]).sort()).toEqual(["id", "message", "sentAt"]);
  });

  it("another learner's attempt, guessed ids and staff are refused", async () => {
    await expect(listMyUnreadNotifications(actor("lina"), "att-leo")).rejects.toBeInstanceOf(NotFoundError);
    await expect(listMyUnreadNotifications(actor("lina"), "att-made-up")).rejects.toBeInstanceOf(NotFoundError);
    await expect(listMyUnreadNotifications(actor("lina"), "")).rejects.toBeInstanceOf(NotFoundError);
    // Leo's notification through Lina's own attempt, or a guessed id:
    await expect(getMyNotification(actor("lina"), "att-lina", "note-3")).rejects.toBeInstanceOf(NotFoundError);
    await expect(getMyNotification(actor("lina"), "att-lina", "note-999")).rejects.toBeInstanceOf(NotFoundError);
    await expect(getMyNotification(actor("lina"), "att-lina", "")).rejects.toBeInstanceOf(NotFoundError);
    for (const who of ["admin", "pat", "eve"]) {
      await expect(listMyUnreadNotifications(actor(who), "att-lina")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(markNotificationRead(actor(who), "att-lina", "note-1")).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("mark-read is ownership-protected and idempotent (the first read time is kept)", async () => {
    await expect(markNotificationRead(actor("leo"), "att-leo", "note-1")).rejects.toBeInstanceOf(NotFoundError); // Lina's, via Leo's attempt
    await expect(markNotificationRead(actor("leo"), "att-lina", "note-1")).rejects.toBeInstanceOf(NotFoundError); // not Leo's attempt
    expect(notes[0].readAt).toBeNull();
    const first = new Date(NOW.getTime() + 5_000);
    await markNotificationRead(actor("lina"), "att-lina", "note-1", first);
    await markNotificationRead(actor("lina"), "att-lina", "note-1", new Date(NOW.getTime() + 60_000)); // again: no error, no change
    expect(notes[0].readAt).toEqual(first);
    await expect(markNotificationRead(actor("lina"), "att-lina", "note-404")).rejects.toBeInstanceOf(NotFoundError);
    expect((await listMyUnreadNotifications(actor("lina"), "att-lina")).map((n) => n.message)).toEqual(["Second message"]);
    expect(await getMyNotification(actor("lina"), "att-lina", "note-1")).toMatchObject({ read: true });
  });

  it("the stream is only for the learner's own attempt while it is in progress", async () => {
    expect(await authorizeMyNotificationStream(actor("lina"), "att-lina")).toEqual({ attemptId: "att-lina", assessmentId: "exam-A" });
    await expect(authorizeMyNotificationStream(actor("lina"), "att-leo")).rejects.toBeInstanceOf(NotFoundError);
    await expect(authorizeMyNotificationStream(actor("pat"), "att-lina")).rejects.toBeInstanceOf(ForbiddenError);
    attempts.get("att-lina")!.status = "SUBMITTED";
    await expect(authorizeMyNotificationStream(actor("lina"), "att-lina")).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("the proctor's notification history", () => {
  it("newest first, with sender and read state — no ids; same authorization as sending", async () => {
    await send("pat", "exam-A", "att-lina", "Older one", new Date(NOW.getTime() - 60_000));
    await send("admin", "exam-A", "att-lina", "Newer one", NOW);
    await markNotificationRead(actor("lina"), "att-lina", "note-1", NOW);
    const history = await listAttemptNotifications(actor("pat"), "exam-A", "att-lina");
    expect(history.map((h) => [h.message, h.sender, h.readAt !== null])).toEqual([
      ["Newer one", { name: "Ada Admin", role: "Administrator" }, false],
      ["Older one", { name: "Pat Proctor", role: "Proctor" }, true],
    ]);
    expect(JSON.stringify(history)).not.toMatch(/note-\d|att-lina|exam-A/);
    await expect(listAttemptNotifications(actor("quinn"), "exam-A", "att-lina")).rejects.toBeInstanceOf(NotFoundError);
    await expect(listAttemptNotifications(actor("pat"), "exam-A", "att-mia")).rejects.toBeInstanceOf(NotFoundError);
    await expect(listAttemptNotifications(actor("lina"), "exam-A", "att-lina")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

describe("realtime delivery", () => {
  it("sending publishes PROCTOR_NOTIFICATION with identifiers only — to the assessment's dashboards and the learner's own attempt", async () => {
    let learnerEvents: MonitoringEvent[] = [];
    const dashboard = await captured(monitoringBus, ["exam-A", "exam-B"], async () => {
      learnerEvents = await captured(learnerNotificationBus, ["att-lina", "att-leo", "att-mia"], () => send("pat", "exam-A", "att-lina"));
    });
    const expected = { type: "PROCTOR_NOTIFICATION", assessmentId: "exam-A", attemptId: "att-lina", at: NOW.toISOString(), notificationId: "note-1" };
    expect(dashboard).toEqual([expected]);
    expect(learnerEvents).toEqual([expected]); // only Lina's attempt topic received it
    expect(JSON.stringify(learnerEvents)).not.toContain("Please stay"); // the text is fetched, not broadcast
  });

  it("the learner bus carries notifications only — never other monitoring events", async () => {
    const got = await captured(learnerNotificationBus, ["att-lina"], () => {
      learnerNotificationBus.publish({ type: "PROCTORING_VIOLATION", assessmentId: "exam-A", attemptId: "att-lina", at: NOW.toISOString() });
    });
    expect(got).toEqual([]);
  });

  it("a refused send publishes nothing", async () => {
    const got = await captured(learnerNotificationBus, ["att-lina", "att-mia"], async () => {
      await expect(send("quinn", "exam-A", "att-lina")).rejects.toBeInstanceOf(NotFoundError);
      await expect(send("pat", "exam-A", "att-lina", "  ")).rejects.toBeInstanceOf(ValidationError);
    });
    expect(got).toEqual([]);
  });

  it("the learner's SSE stream receives only their own attempt's notification", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    try {
      const abort = new AbortController();
      const read = (attemptId: string) => {
        const reader = createMonitoringStream({ assessmentId: "exam-A", topic: attemptId, bus: learnerNotificationBus, signal: abort.signal, recheck: async () => true }).getReader();
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
      const lina = read("att-lina");
      const leo = read("att-leo");
      await vi.advanceTimersByTimeAsync(0);
      await send("pat", "exam-A", "att-lina");
      await vi.advanceTimersByTimeAsync(0);
      expect(lina()).toContain('event: PROCTOR_NOTIFICATION\ndata: {"type":"PROCTOR_NOTIFICATION","assessmentId":"exam-A","attemptId":"att-lina"');
      expect(leo()).not.toContain("PROCTOR_NOTIFICATION");
      abort.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(learnerNotificationBus.subscriberCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a realtime failure doesn't affect the notification: it is stored and the fallback read still finds it", async () => {
    vi.spyOn(monitoringBus, "publish").mockImplementation(() => {
      throw new Error("bus down");
    });
    vi.spyOn(learnerNotificationBus, "publish").mockImplementation(() => {
      throw new Error("bus down");
    });
    await expect(send("pat", "exam-A", "att-lina", "Please restore screen sharing.")).resolves.toMatchObject({ learnerName: "Lina" });
    expect(notes).toHaveLength(1);
    expect((await listMyUnreadNotifications(actor("lina"), "att-lina")).map((n) => n.message)).toEqual(["Please restore screen sharing."]);
  });
});

// ---------------------------------------------------------------------------
// UI rules (shared by the proctor's form and the learner's exam)
// ---------------------------------------------------------------------------

describe("proctor form rules", () => {
  it("the quick messages are the five templates, each a valid message", () => {
    expect(QUICK_NOTIFICATIONS).toEqual([
      "Please stay on the assessment screen.",
      "Please restore camera access.",
      "Please restore screen sharing.",
      "Please ensure your face is clearly visible.",
      "Please ensure only you are visible on camera.",
    ]);
    for (const q of QUICK_NOTIFICATIONS) expect(checkNotificationMessage(q)).toEqual({ ok: true, message: q });
  });

  it("custom message validation mirrors the server", () => {
    expect(checkNotificationMessage("   ")).toMatchObject({ ok: false });
    expect(checkNotificationMessage("ab")).toMatchObject({ ok: false });
    expect(checkNotificationMessage(" abc ")).toEqual({ ok: true, message: "abc" });
    expect(checkNotificationMessage("x".repeat(301))).toMatchObject({ ok: false });
  });

  it("the Send button: enabled only for a valid message and not while a send is in flight", () => {
    expect(canSendNotification("", false)).toBe(false);
    expect(canSendNotification("  ", false)).toBe(false);
    expect(canSendNotification(QUICK_NOTIFICATIONS[0], false)).toBe(true);
    expect(canSendNotification(QUICK_NOTIFICATIONS[0], true)).toBe(false); // no duplicate submissions
  });
});

describe("learner display rules", () => {
  const n = (id: string, minute: number, message = `msg ${id}`): LearnerNotification => ({ id, message, sentAt: new Date(NOW.getTime() + minute * 60_000).toISOString() });

  it("notifications are shown oldest → newest (the newest prominently), without duplicates, a few at most", () => {
    let list = mergeNotifications([], [n("b", 2), n("a", 1)]);
    list = mergeNotifications(list, [n("b", 2), n("c", 3)]); // "b" again (stream and poll)
    expect(list.map((x) => x.id)).toEqual(["a", "b", "c"]);
    const many = mergeNotifications([], Array.from({ length: 9 }, (_, i) => n(`m${i}`, i)));
    expect(many).toHaveLength(MAX_SHOWN_NOTIFICATIONS);
    expect(many.at(-1)!.id).toBe("m8");
  });

  it("\"Got it\" removes it, and a later poll doesn't bring it back", () => {
    const dismissed = new Set<string>();
    let list = mergeNotifications([], [n("a", 1), n("b", 2)]);
    dismissed.add("b");
    list = dismissNotification(list, "b");
    expect(list.map((x) => x.id)).toEqual(["a"]);
    list = mergeNotifications(list, [n("a", 1), n("b", 2)], dismissed);
    expect(list.map((x) => x.id)).toEqual(["a"]);
  });

  it("polling: 15 s without the stream, 30 s as a safety net with it", () => {
    expect(notificationPollMs(false)).toBe(15_000);
    expect(notificationPollMs(true)).toBe(30_000);
  });
});
