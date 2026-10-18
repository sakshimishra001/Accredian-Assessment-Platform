/*
 * Where a learner stands with each assigned assessment, and where they land after signing in. Pure
 * rules over the server's own overview of each assessment (getMyExamOverview: server time, attempt
 * states, window, attempts left) — the decision is made on the server, never in the browser.
 */

export type LearnerAssessmentState = "in_progress" | "open" | "upcoming" | "completed" | "closed";

export interface LearnerAssessmentFacts {
  inProgressAttemptId: string | null;
  /** The server's hint that a new attempt can be started now (open window, attempts left, nothing running). */
  canStart: boolean;
  attempts: readonly { status: string }[];
  serverTime: Date | string;
  assessment: { id: string; startAt: Date | string };
}

/** The learner's state for one assessment. */
export function learnerAssessmentState(o: LearnerAssessmentFacts): LearnerAssessmentState {
  if (o.inProgressAttemptId) return "in_progress";
  if (o.canStart) return "open";
  if (o.attempts.length) return "completed";
  return new Date(o.serverTime) < new Date(o.assessment.startAt) ? "upcoming" : "closed";
}

/**
 * The assessment to take the learner straight to after signing in, or null for the dashboard:
 * - an attempt in progress (resumed under the usual attempt rules) — if there is exactly one;
 * - otherwise an assessment open right now that they haven't attempted yet (no submitted or
 *   terminated attempt) — if there is exactly one.
 * Several candidates at once is ambiguous, so the learner chooses on the dashboard. Scheduled,
 * completed, terminated and closed assessments always go to the dashboard (retakes start there).
 */
export function landingAssessmentId(items: readonly LearnerAssessmentFacts[]): string | null {
  const running = items.filter((o) => learnerAssessmentState(o) === "in_progress");
  if (running.length) return running.length === 1 ? running[0].assessment.id : null;
  const fresh = items.filter((o) => learnerAssessmentState(o) === "open" && o.attempts.length === 0);
  return fresh.length === 1 ? fresh[0].assessment.id : null;
}

export const LEARNER_DASHBOARD = "/learner";
export const learnerAssessmentPath = (assessmentId: string) => `/learner/assessment/${assessmentId}`;

/** The path after sign-in: the assessment's instructions / exam, or the dashboard. */
export function learnerLandingPath(items: readonly LearnerAssessmentFacts[]): string {
  const id = landingAssessmentId(items);
  return id ? learnerAssessmentPath(id) : LEARNER_DASHBOARD;
}
