import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LearnerLoginForm } from "@/app/learner/login/learner-login-form";
import { findProtectedRoute, isProtectedPath, loginPathFor, resolvePostLoginPath } from "@/lib/auth/rbac";
import { landingAssessmentId, learnerAssessmentState, learnerLandingPath, type LearnerAssessmentFacts } from "@/lib/learner/landing";
import { createAssessmentSchema, updateAssessmentSchema } from "@/lib/validation/assessment";
import { learnerLoginSchema } from "@/lib/validation/learner";

/*
 * Learner sign-in and landing: the rules that need no database. (The same rules run against
 * PostgreSQL in tests/integration/learner-password.test.ts.)
 */

const NOW = new Date("2026-10-18T10:00:00Z");
const fact = (id: string, o: Partial<LearnerAssessmentFacts> = {}): LearnerAssessmentFacts => ({
  inProgressAttemptId: null,
  canStart: false,
  attempts: [],
  serverTime: NOW,
  assessment: { id, startAt: new Date("2026-10-18T09:00:00Z") },
  ...o,
});
const open = (id: string) => fact(id, { canStart: true });
const running = (id: string) => fact(id, { inProgressAttemptId: `att-${id}`, attempts: [{ status: "IN_PROGRESS" }] });
const upcoming = (id: string) => fact(id, { assessment: { id, startAt: new Date("2026-10-19T09:00:00Z") } });
const submitted = (id: string) => fact(id, { attempts: [{ status: "SUBMITTED" }] });
const terminated = (id: string) => fact(id, { attempts: [{ status: "TERMINATED" }] });

describe("post-login landing", () => {
  it("D: one active, unattempted assessment → straight to its instructions", () => {
    expect(learnerLandingPath([open("a"), upcoming("b"), submitted("c")])).toBe("/learner/assessment/a");
  });

  it("D: an attempt in progress → straight back to it (resumed under the attempt rules), even if another is open", () => {
    expect(learnerLandingPath([open("a"), running("b")])).toBe("/learner/assessment/b");
  });

  it("E: nothing active (or nothing assigned) → dashboard", () => {
    expect(learnerLandingPath([])).toBe("/learner");
    expect(learnerLandingPath([fact("closed")])).toBe("/learner");
  });

  it("F: only scheduled assessments → dashboard (shown as upcoming)", () => {
    expect(learnerLandingPath([upcoming("a"), upcoming("b")])).toBe("/learner");
    expect(learnerAssessmentState(upcoming("a"))).toBe("upcoming");
  });

  it("G: submitted or terminated → dashboard, even if a retake could be started there", () => {
    expect(learnerLandingPath([submitted("a")])).toBe("/learner");
    expect(learnerLandingPath([terminated("a")])).toBe("/learner");
    // Attempts left (canStart) but already attempted: the learner goes to the dashboard, not into a retake.
    expect(learnerLandingPath([fact("a", { canStart: true, attempts: [{ status: "SUBMITTED" }] })])).toBe("/learner");
    expect(learnerAssessmentState(submitted("a"))).toBe("completed");
  });

  it("several candidates at once is ambiguous → dashboard (no guessing)", () => {
    expect(landingAssessmentId([open("a"), open("b")])).toBeNull();
    expect(landingAssessmentId([running("a"), running("b")])).toBeNull();
  });
});

describe("learner sign-in route", () => {
  it("/learner/login is public; the rest of /learner still needs a learner; staff areas unchanged", () => {
    expect(isProtectedPath("/learner/login")).toBe(false);
    expect(findProtectedRoute("/learner")?.roles).toEqual(["LEARNER"]);
    expect(findProtectedRoute("/learner/assessment/x")?.roles).toEqual(["LEARNER"]);
    expect(findProtectedRoute("/admin")?.roles).toEqual(["ADMIN"]);
    expect(isProtectedPath("/login")).toBe(false);
  });

  it("signed-out learners are sent to /learner/login; staff to /login", () => {
    expect(loginPathFor("/learner")).toBe("/learner/login");
    expect(loginPathFor("/learner/assessment/abc")).toBe("/learner/login");
    expect(loginPathFor("/admin/assessments")).toBe("/login");
    expect(loginPathFor("/examiner")).toBe("/login");
  });

  it("the sign-in page itself is never a post-login destination; other roles keep their areas (J)", () => {
    expect(resolvePostLoginPath("LEARNER", "/learner/login")).toBe("/learner");
    expect(resolvePostLoginPath("LEARNER", "/learner/results")).toBe("/learner/results");
    expect(resolvePostLoginPath("LEARNER", "/admin")).toBe("/learner");
    expect(resolvePostLoginPath("ADMIN", "/admin/assessments")).toBe("/admin/assessments");
    expect(resolvePostLoginPath("EXAMINER", undefined)).toBe("/examiner");
    expect(resolvePostLoginPath("REVIEWER", "/learner")).toBe("/proctor");
  });

  it("H: the learner sign-in form asks for email and password only — no role to choose", () => {
    const html = renderToStaticMarkup(createElement(LearnerLoginForm, { action: async () => null }));
    expect(html).toMatch(/<input[^>]*name="email"/);
    expect(html).toMatch(/<input[^>]*name="password"[^>]*type="password"|<input[^>]*type="password"[^>]*name="password"/);
    expect(html).not.toMatch(/<select/i);
    expect(html).not.toMatch(/name="role"|Select your role|Administrator|Examiner|Proctor/);
    expect(html).toContain("Accredian");
  });

  it("the learner password is taken as typed (only exam codes were normalised)", () => {
    expect(learnerLoginSchema.parse({ email: " Lina@Example.com ", password: "aBc-123 x" })).toEqual({ email: "lina@example.com", password: "aBc-123 x" });
    expect(learnerLoginSchema.safeParse({ email: "lina@example.com", password: "" }).success).toBe(false);
  });
});

describe("I: no course in assessment creation", () => {
  const base = { name: "Mid term", type: "OBJECTIVE", durationMinutes: 60, startAt: "2026-11-01T10:00", endAt: "2026-11-01T13:00", passingMarks: 1 };

  it("a batch (and name) is enough — no course is required", () => {
    const r = createAssessmentSchema.safeParse({ ...base, batchId: "batch-1" });
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty("courseId", expect.any(String));
  });

  it("without a batch, the batch is what's asked for (not a course)", () => {
    const r = createAssessmentSchema.safeParse(base);
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join("."))).toEqual(["batchId"]);
  });

  it("the course can't be edited: updates ignore it", () => {
    const r = updateAssessmentSchema.safeParse({ courseId: "c-2" });
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty("courseId");
  });
});
