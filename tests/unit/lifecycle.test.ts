import { describe, expect, it } from "vitest";
import {
  availableActions,
  canEditQuestions,
  checkTransition,
  editableFields,
  isFieldEditable,
  STATUS_ORDER,
  timeBasedStatus,
  TRANSITIONS,
  type TransitionContext,
} from "@/lib/assessments/lifecycle";
import type { AssessmentStatus } from "@/generated/prisma/enums";

const NOW = new Date("2026-10-01T10:00:00+05:30");
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    status: "DRAFT",
    type: "OBJECTIVE",
    startAt: hours(24),
    endAt: hours(26),
    passingMarks: 4,
    totalMarks: 10,
    questionCount: 5,
    objectiveCount: 5,
    subjectiveCount: 0,
    incompatibleCount: 0,
    archivedQuestionCount: 0,
    paper: {},
    batch: { active: true, learnerCount: 3 },
    openAttemptCount: 0,
    pendingEvaluationCount: 0,
    ...overrides,
  };
}

describe("transition graph", () => {
  it("only allows the documented manual moves", () => {
    const allowed = new Set(TRANSITIONS.filter((t) => t.triggers.includes("manual")).map((t) => `${t.from}->${t.to}`));
    for (const from of STATUS_ORDER) {
      for (const to of STATUS_ORDER) {
        if (from === to) continue;
        const res = checkTransition(ctx({ status: from, type: "MIXED", objectiveCount: 2, subjectiveCount: 3 }), to, { now: NOW });
        if (!allowed.has(`${from}->${to}`)) expect(res.ok, `${from}->${to}`).toBe(false);
      }
    }
  });

  it.each<[AssessmentStatus, AssessmentStatus]>([
    ["DRAFT", "PUBLISHED"],
    ["DRAFT", "ACTIVE"],
    ["SCHEDULED", "PUBLISHED"],
    ["ENDED", "SCHEDULED"],
    ["PUBLISHED", "DRAFT"],
    ["ARCHIVED", "DRAFT"],
  ])("rejects %s → %s", (from, to) => {
    expect(checkTransition(ctx({ status: from }), to, { now: NOW }).ok).toBe(false);
  });

  it("does not let an admin activate manually — activation is time-driven", () => {
    const res = checkTransition(ctx({ status: "SCHEDULED", startAt: hours(-1) }), "ACTIVE", { now: NOW, trigger: "manual" });
    expect(res.ok).toBe(false);
    expect(checkTransition(ctx({ status: "SCHEDULED", startAt: hours(-1) }), "ACTIVE", { now: NOW, trigger: "system" }).ok).toBe(true);
  });
});

describe("pause / resume (live assessments)", () => {
  const live = { startAt: hours(-1), endAt: hours(1) };

  it("an admin can pause a live assessment and resume a paused one, only inside the window", () => {
    expect(checkTransition(ctx({ status: "ACTIVE", ...live }), "PAUSED", { now: NOW }).ok).toBe(true);
    expect(checkTransition(ctx({ status: "PAUSED", ...live }), "ACTIVE", { now: NOW }).ok).toBe(true);
    const after = { now: hours(2) };
    expect(checkTransition(ctx({ status: "ACTIVE", ...live }), "PAUSED", after)).toEqual({ ok: false, reasons: ["The assessment's end time has passed."] });
    expect(checkTransition(ctx({ status: "PAUSED", ...live }), "ACTIVE", after).ok).toBe(false);
  });

  it.each<[AssessmentStatus, AssessmentStatus]>([
    ["PAUSED", "PAUSED"],
    ["ENDED", "PAUSED"],
    ["SCHEDULED", "PAUSED"],
    ["SCHEDULED", "ACTIVE"],
    ["ENDED", "ACTIVE"],
    ["PAUSED", "ENDED"],
    ["PAUSED", "DRAFT"],
  ])("rejects %s → %s by hand", (from, to) => {
    expect(checkTransition(ctx({ status: from, ...live }), to, { now: NOW }).ok).toBe(false);
  });

  it("a paused assessment still ends at its end time (the clock, not a pause, closes the window)", () => {
    expect(timeBasedStatus("PAUSED", live.startAt, live.endAt, NOW)).toBe("PAUSED");
    expect(timeBasedStatus("PAUSED", live.startAt, live.endAt, hours(1))).toBe("ENDED");
    expect(checkTransition(ctx({ status: "PAUSED", ...live }), "ENDED", { now: hours(1), trigger: "system" }).ok).toBe(true);
    expect(checkTransition(ctx({ status: "PAUSED", ...live }), "ENDED", { now: NOW, trigger: "system" }).ok).toBe(false);
  });

  it("nothing can be edited while paused; the live actions offer pause or resume", () => {
    expect(editableFields("PAUSED")).toEqual([]);
    expect(availableActions(ctx({ status: "ACTIVE", ...live }), NOW).map((a) => a.to)).toEqual(["ENDED", "PAUSED"]);
    expect(availableActions(ctx({ status: "PAUSED", ...live }), NOW).map((a) => a.to)).toEqual(["ACTIVE"]);
  });
});

describe("DRAFT → SCHEDULED readiness", () => {
  it("passes for a complete assessment", () => {
    expect(checkTransition(ctx(), "SCHEDULED", { now: NOW })).toEqual({ ok: true });
  });

  it.each<[string, Partial<TransitionContext>, RegExp]>([
    ["no questions", { questionCount: 0, totalMarks: 0, objectiveCount: 0 }, /at least one question/],
    ["zero total marks", { totalMarks: 0, passingMarks: 0 }, /greater than zero/],
    ["passing > total", { passingMarks: 11 }, /exceed total/],
    ["start in the past", { startAt: hours(-1) }, /future/],
    ["incompatible questions", { incompatibleCount: 1 }, /do not match/],
    ["inactive questions", { archivedQuestionCount: 2 }, /inactive question/],
    ["mixed without subjective", { type: "MIXED", subjectiveCount: 0 }, /one objective and one subjective/],
  ])("blocks when %s", (_label, overrides, reason) => {
    const res = checkTransition(ctx(overrides), "SCHEDULED", { now: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons.join(" ")).toMatch(reason);
  });
});

describe("publish prerequisites: paper and batch", () => {
  const reasons = (overrides: Partial<TransitionContext>) => {
    const r = checkTransition(ctx(overrides), "SCHEDULED", { now: NOW });
    return r.ok ? [] : r.reasons;
  };

  it("requires a question paper — any selected paper; there is no approval", () => {
    expect(reasons({ paper: null })).toEqual(["Select a question paper."]);
    expect(reasons({ paper: {} })).toEqual([]);
  });

  it("requires an active batch with active learners", () => {
    expect(reasons({ batch: null })).toEqual(["Select the batch that will take this assessment."]);
    expect(reasons({ batch: { active: false, learnerCount: 5 } })).toEqual(["The selected batch is inactive."]);
    expect(reasons({ batch: { active: true, learnerCount: 0 } })).toEqual(["The selected batch has no active learners."]);
  });

  it("reports every missing prerequisite at once", () => {
    expect(reasons({ paper: null, batch: null, questionCount: 0, totalMarks: 0, startAt: hours(-1) })).toEqual([
      "Select a question paper.",
      "Select the batch that will take this assessment.",
      "Add at least one question.",
      "Passing marks (4) exceed total marks (0).",
      "Start time must be in the future.",
    ]);
  });
});

describe("results readiness", () => {
  it("needs no running attempts and every evaluation finalized", () => {
    const ended = ctx({ status: "ENDED", type: "OBJECTIVE" });
    expect(checkTransition(ended, "RESULT_READY", { now: NOW })).toEqual({ ok: true });
    expect(checkTransition({ ...ended, openAttemptCount: 2 }, "RESULT_READY", { now: NOW })).toEqual({ ok: false, reasons: ["2 attempt(s) are still in progress."] });
    const evaluating = ctx({ status: "EVALUATION", type: "MIXED", pendingEvaluationCount: 3 });
    expect(checkTransition(evaluating, "RESULT_READY", { now: NOW })).toEqual({ ok: false, reasons: ["3 attempt(s) still need evaluation."] });
  });
});

describe("other guarded transitions", () => {
  it("allows unscheduling only before the start time", () => {
    expect(checkTransition(ctx({ status: "SCHEDULED" }), "DRAFT", { now: NOW }).ok).toBe(true);
    expect(checkTransition(ctx({ status: "SCHEDULED", startAt: hours(-1) }), "DRAFT", { now: NOW }).ok).toBe(false);
  });

  it("allows ending an active assessment early", () => {
    expect(checkTransition(ctx({ status: "ACTIVE" }), "ENDED", { now: NOW }).ok).toBe(true);
  });

  it("routes objective assessments straight to results and others through evaluation", () => {
    expect(checkTransition(ctx({ status: "ENDED", type: "OBJECTIVE" }), "RESULT_READY", { now: NOW }).ok).toBe(true);
    expect(checkTransition(ctx({ status: "ENDED", type: "OBJECTIVE" }), "EVALUATION", { now: NOW }).ok).toBe(false);
    expect(checkTransition(ctx({ status: "ENDED", type: "SUBJECTIVE" }), "RESULT_READY", { now: NOW }).ok).toBe(false);
    expect(checkTransition(ctx({ status: "ENDED", type: "MIXED" }), "EVALUATION", { now: NOW }).ok).toBe(true);
  });

  it("walks a subjective assessment through to archive", () => {
    const path: AssessmentStatus[] = ["ENDED", "EVALUATION", "RESULT_READY", "PUBLISHED", "ARCHIVED"];
    for (let i = 0; i < path.length - 1; i++) {
      expect(checkTransition(ctx({ status: path[i], type: "SUBJECTIVE" }), path[i + 1], { now: NOW }).ok).toBe(true);
    }
  });

  it("lists manual actions with their current eligibility", () => {
    const actions = availableActions(ctx({ status: "DRAFT", questionCount: 0, totalMarks: 0 }), NOW);
    expect(actions.map((a) => a.to).sort()).toEqual(["ARCHIVED", "SCHEDULED"]);
    expect(actions.find((a) => a.to === "SCHEDULED")!.check.ok).toBe(false);
    expect(actions.find((a) => a.to === "ARCHIVED")!.check.ok).toBe(true);
  });
});

describe("timeBasedStatus", () => {
  const start = hours(1);
  const end = hours(3);
  it.each<[AssessmentStatus, Date, AssessmentStatus]>([
    ["SCHEDULED", hours(0), "SCHEDULED"],
    ["SCHEDULED", hours(1), "ACTIVE"],
    ["SCHEDULED", hours(2), "ACTIVE"],
    ["SCHEDULED", hours(3), "ENDED"],
    ["ACTIVE", hours(2), "ACTIVE"],
    ["ACTIVE", hours(3), "ENDED"],
    ["DRAFT", hours(5), "DRAFT"],
    ["ENDED", hours(5), "ENDED"],
    ["PUBLISHED", hours(5), "PUBLISHED"],
  ])("%s at %s → %s", (status, now, expected) => {
    expect(timeBasedStatus(status, start, end, now)).toBe(expected);
  });
});

describe("edit policy", () => {
  it("allows everything in draft", () => {
    expect(editableFields("DRAFT")).toContain("type");
    expect(canEditQuestions("DRAFT")).toBe(true);
  });

  it("freezes questions and rules once scheduled", () => {
    expect(canEditQuestions("SCHEDULED")).toBe(false);
    expect(isFieldEditable("SCHEDULED", "durationMinutes")).toBe(false);
    expect(isFieldEditable("SCHEDULED", "paperId")).toBe(false);
    expect(isFieldEditable("SCHEDULED", "batchId")).toBe(false);
    expect(isFieldEditable("SCHEDULED", "instructions")).toBe(true);
    expect(isFieldEditable("DRAFT", "randomizeQuestions")).toBe(true);
    expect(isFieldEditable("SCHEDULED", "passingMarks")).toBe(false);
    expect(isFieldEditable("SCHEDULED", "startAt")).toBe(true);
  });

  it("only allows extending the end time while active", () => {
    expect(editableFields("ACTIVE")).toEqual(["endAt"]);
    expect(canEditQuestions("ACTIVE")).toBe(false);
  });

  it.each<AssessmentStatus>(["ENDED", "EVALUATION", "RESULT_READY", "PUBLISHED", "ARCHIVED"])("is read-only when %s", (s) => {
    expect(editableFields(s)).toEqual([]);
    expect(canEditQuestions(s)).toBe(false);
  });
});
