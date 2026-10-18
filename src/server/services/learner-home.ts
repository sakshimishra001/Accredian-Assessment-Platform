import "server-only";
import { AssessmentStatus, Role } from "@/generated/prisma/enums";
import { learnerLandingPath } from "@/lib/learner/landing";
import { forAssessment, type SessionUser } from "../auth/session";
import { assertRole } from "../authz";
import { db } from "../db";
import { getMyExamOverview } from "./attempts";

/**
 * The learner's assigned assessments (newest first), each as the learner sees it — drafts are
 * never shown. Assignment (a candidate row) is what makes an assessment the learner's.
 */
export async function listMyAssessments(actor: SessionUser, now: Date = new Date()) {
  assertRole(actor, Role.LEARNER);
  const rows = await db.assessmentCandidate.findMany({
    where: { learnerId: actor.id, assessment: { status: { not: AssessmentStatus.DRAFT } } },
    orderBy: [{ assessment: { startAt: "desc" } }, { assessmentId: "asc" }],
    select: { assessmentId: true },
  });
  return Promise.all(rows.map((r) => getMyExamOverview(forAssessment(actor, r.assessmentId), now)));
}

export type MyAssessment = Awaited<ReturnType<typeof listMyAssessments>>[number];

/**
 * Where the learner goes after signing in, from their actual assignments, attempts and the server
 * clock: straight to an active, unfinished assessment, otherwise the dashboard (see lib/learner/landing.ts).
 */
export async function getLearnerLandingPath(actor: SessionUser, now: Date = new Date()) {
  return learnerLandingPath(await listMyAssessments(actor, now));
}
