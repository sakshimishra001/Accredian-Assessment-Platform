import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCK_MESSAGE, lockedByFrom, TERMINATION_LABEL, TERMINATION_MESSAGE, terminatedByFrom } from "@/lib/learner/staff-action";

/*
 * Proctor dashboard, phase 4: the learner is told who locked or terminated their attempt — the
 * violation limit, a proctor or an administrator — never IDs, names or reasons. The real attempt
 * clock (what the exam screen polls) runs against an in-memory stand-in for the database.
 */

const NOW = new Date("2026-10-22T10:00:00Z");
type Attempt = Record<string, unknown> & { id: string; learnerId: string; status: string; lockedAt: Date | null; terminatedById: string | null; terminationReason: string | null };
const attempts = new Map<string, Attempt>();
const users = new Map<string, { role: "ADMIN" | "REVIEWER" | "LEARNER" }>();
const events: { attemptId: string; actionTaken: string | null }[] = [];
const audits: { entityType: string; entityId: string; action: string; actorId: string | null; createdAt: Date }[] = [];

const assessment = { timingMode: "FULL_DURATION", endAt: new Date("2026-10-22T14:00:00Z"), durationMinutes: 60, status: "ACTIVE", pausedAt: null };
const withAssessment = (a: Attempt) => ({ ...a, assessment });

const fakeDb = {
  assessmentAttempt: {
    findFirst: async ({ where }: { where: { id: string; learnerId: string } }) => {
      const a = attempts.get(where.id);
      return a && a.learnerId === where.learnerId ? withAssessment(a) : null;
    },
    updateMany: async ({ where }: { where: { id: string; status: string } }) => ({ count: attempts.get(where.id)?.status === where.status ? 1 : 0 }),
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const a = attempts.get(where.id)!;
      return { ...a, terminatedBy: a.terminatedById ? { role: users.get(a.terminatedById)!.role } : null };
    },
  },
  proctoringEvent: { count: async ({ where }: { where: { attemptId: string; actionTaken: string } }) => events.filter((e) => e.attemptId === where.attemptId && e.actionTaken === where.actionTaken).length },
  auditLog: {
    findFirst: async ({ where }: { where: { entityId: string; action: string; entityType: string } }) => {
      const hit = audits.filter((x) => x.entityType === where.entityType && x.entityId === where.entityId && x.action === where.action && x.actorId).at(-1);
      return hit ? { actor: { role: users.get(hit.actorId!)!.role } } : null;
    },
  },
  $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb),
};

vi.mock("@/server/db", () => ({ db: fakeDb }));
vi.stubEnv("DATABASE_URL", "postgresql://unit:unit@localhost:5432/unit_test");

const { getMyAttemptClock, FOCUS_TERMINATION_REASON, PROCTORING_TERMINATION_REASON } = await import("@/server/services/attempts");
const learner = { id: "lina", email: "lina@example.com", name: "Lina", role: "LEARNER" as const };

function attempt(patch: Partial<Attempt> = {}) {
  attempts.set("att", {
    id: "att",
    assessmentId: "exam-A",
    learnerId: "lina",
    status: "IN_PROGRESS",
    startedAt: new Date("2026-10-22T09:30:00Z"),
    deadlineAt: new Date("2026-10-22T10:30:00Z"),
    pausedSeconds: 0,
    extensionSeconds: 0,
    lockedAt: null,
    terminatedById: null,
    terminationReason: null,
    ...patch,
  });
}

beforeEach(() => {
  attempts.clear();
  events.length = 0;
  audits.length = 0;
  users.clear();
  users.set("admin", { role: "ADMIN" });
  users.set("pat", { role: "REVIEWER" });
});

describe("lock: what the learner is told", () => {
  it("automatic (violation limit) lock keeps the existing wording", async () => {
    attempt({ lockedAt: NOW });
    events.push({ attemptId: "att", actionTaken: "LOCK" });
    const clock = await getMyAttemptClock(learner, "att", NOW);
    expect(clock).toMatchObject({ locked: true, lockedBy: "violation_limit" });
    expect(LOCK_MESSAGE[clock.lockedBy!]).toBe("Your exam has been locked because the proctoring violation limit was reached.");
  });

  it("a proctor's manual lock says so — no violation-limit wording", async () => {
    attempt({ lockedAt: NOW });
    audits.push({ entityType: "AssessmentAttempt", entityId: "att", action: "attempt.locked", actorId: "pat", createdAt: NOW });
    const clock = await getMyAttemptClock(learner, "att", NOW);
    expect(clock.lockedBy).toBe("proctor");
    expect(LOCK_MESSAGE[clock.lockedBy!]).toBe("Your assessment has been locked by a proctor.");
  });

  it("an administrator's manual lock says so", async () => {
    attempt({ lockedAt: NOW });
    audits.push({ entityType: "AssessmentAttempt", entityId: "att", action: "attempt.locked", actorId: "admin", createdAt: NOW });
    expect((await getMyAttemptClock(learner, "att", NOW)).lockedBy).toBe("administrator");
  });

  it("not locked: no lock source", async () => {
    attempt();
    expect(await getMyAttemptClock(learner, "att", NOW)).toMatchObject({ locked: false, lockedBy: null, terminatedBy: null });
  });
});

describe("termination: what the learner is told", () => {
  it("an administrator's termination: administrator wording", async () => {
    attempt({ status: "TERMINATED", terminatedById: "admin", terminationReason: "Impersonation" });
    const clock = await getMyAttemptClock(learner, "att", NOW);
    expect(clock).toMatchObject({ status: "TERMINATED", terminatedBy: "administrator", terminatedByFocus: false });
    expect(TERMINATION_MESSAGE[clock.terminatedBy!]).toBe("Your assessment was terminated by an administrator.");
  });

  it("a proctor's termination: proctor wording", async () => {
    attempt({ status: "TERMINATED", terminatedById: "pat", terminationReason: "Assistance observed" });
    const clock = await getMyAttemptClock(learner, "att", NOW);
    expect(clock.terminatedBy).toBe("proctor");
    expect(TERMINATION_MESSAGE[clock.terminatedBy!]).toBe("Your assessment was terminated by a proctor.");
    // The staff reason never reaches the learner.
    expect(JSON.stringify(clock)).not.toContain("Assistance observed");
  });

  it("the violation limit's termination keeps the existing wording", async () => {
    for (const reason of [FOCUS_TERMINATION_REASON, PROCTORING_TERMINATION_REASON]) {
      attempt({ status: "TERMINATED", terminatedById: null, terminationReason: reason });
      const clock = await getMyAttemptClock(learner, "att", NOW);
      expect(clock).toMatchObject({ terminatedBy: "violation_limit", terminatedByFocus: true });
      expect(TERMINATION_MESSAGE[clock.terminatedBy!]).toBe("Your assessment has been terminated because the proctoring violation limit was reached.");
    }
  });
});

describe("the rules on their own", () => {
  it("lock and termination sources, and wording never naming anyone", () => {
    expect(lockedByFrom({ violationLock: true, staffRole: "ADMIN" })).toBe("violation_limit");
    expect(lockedByFrom({ violationLock: false, staffRole: "REVIEWER" })).toBe("proctor");
    expect(lockedByFrom({ violationLock: false, staffRole: null })).toBe("staff");
    expect(terminatedByFrom({ terminatedById: null, staffRole: null, proctoringReason: false })).toBe("staff");
    expect(terminatedByFrom({ terminatedById: "x", staffRole: "EXAMINER", proctoringReason: false })).toBe("staff");
    expect(TERMINATION_LABEL.proctor).toBe("Terminated by a proctor");
    for (const text of [...Object.values(LOCK_MESSAGE), ...Object.values(TERMINATION_MESSAGE), ...Object.values(TERMINATION_LABEL)]) {
      expect(text).not.toMatch(/REVIEWER|ADMIN\b|the administrator\b/);
    }
  });
});
