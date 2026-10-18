import "server-only";
import { AssessmentStatus, AttemptStatus, Role } from "@/generated/prisma/enums";
import { NotFoundError } from "@/lib/errors";
import type { QuestionSnapshot } from "@/lib/questions/snapshot";
import { questionKind } from "@/lib/questions/types";
import type { SessionUser } from "../auth/session";
import { assertRole } from "../authz";
import { db } from "../db";
import { closeExpiredAttempts } from "./attempts";
import { calculateAttemptResult } from "@/lib/scoring/result";
import { numbering, resultAttemptSelect, resultInputs, resultOf, timeTakenSeconds, type ResultAttemptRow } from "./results";

/*
 * Assessment analytics for staff: operational counts, score statistics, question analysis and
 * batch performance — aggregates only, never one learner's answers or feedback.
 *
 * Every mark comes from the existing result calculation (`resultOf`). A candidate's result is their
 * best final attempt, as on the results page; attempts still awaiting evaluation are counted as
 * pending and never scored. Terminated attempts are not submissions and are never scored.
 *
 * Scope: admins see every candidate. An examiner sees only the candidates assigned to them; an
 * assessment with none is "not found".
 */

const SUBMITTED: AttemptStatus[] = [AttemptStatus.SUBMITTED, AttemptStatus.AUTO_SUBMITTED];
const { assessment: assessmentSelect, ...attemptSelect } = resultAttemptSelect;

const round2 = (n: number) => Math.round(n * 100) / 100;
const rate = (part: number, whole: number) => (whole > 0 ? round2((part / whole) * 100) : null);

/** Average, highest and lowest of the final results (nulls when there are none). */
function scoreStats(results: { obtained: number; percentage: number }[]) {
  if (!results.length) return { averageScore: null, averagePercentage: null, highestScore: null, lowestScore: null };
  const marks = results.map((r) => r.obtained);
  return {
    averageScore: round2(marks.reduce((a, b) => a + b, 0) / marks.length),
    averagePercentage: round2(results.reduce((a, r) => a + r.percentage, 0) / results.length),
    highestScore: Math.max(...marks),
    lowestScore: Math.min(...marks),
  };
}

export async function getAssessmentAnalytics(actor: SessionUser, assessmentId: string, now: Date = new Date()) {
  assertRole(actor, Role.ADMIN, Role.EXAMINER);
  const scope = actor.role === Role.ADMIN ? {} : { examinerId: actor.id };
  // Examiners: only assessments where they have assigned candidates (checked before anything else).
  if (actor.role !== Role.ADMIN && (await db.assessmentCandidate.count({ where: { assessmentId, ...scope } })) === 0) throw new NotFoundError("Assessment not found.");

  await closeExpiredAttempts(now, assessmentId);
  // Three queries regardless of the number of candidates, attempts or answers.
  const assessment = await db.assessment.findUnique({ where: { id: assessmentId }, select: { ...assessmentSelect.select, courseId: true } });
  if (!assessment) throw new NotFoundError("Assessment not found.");
  const [candidates, attempts] = await Promise.all([
    db.assessmentCandidate.findMany({
      where: { assessmentId, ...scope },
      select: { id: true, learner: { select: { batchMemberships: { where: { batch: { courseId: assessment.courseId } }, select: { batch: { select: { id: true, name: true } } } } } } },
    }),
    db.assessmentAttempt.findMany({ where: { assessmentId, candidate: scope }, orderBy: { attemptNumber: "asc" }, select: { ...attemptSelect, candidateId: true } }),
  ]);

  const passingMarks = assessment.passingMarks.toNumber();
  const hasPassRule = passingMarks > 0;

  // Score every attempt with the existing calculation (the assessment content is shared).
  const scored = attempts.map((a) => {
    const row = { ...a, assessment } as unknown as ResultAttemptRow;
    const terminated = a.status === AttemptStatus.TERMINATED;
    return { attempt: a, result: terminated ? null : resultOf(row) };
  });

  // Per candidate: attempts, and their result = best final attempt.
  const byCandidate = new Map(candidates.map((c) => [c.id, [] as typeof scored]));
  for (const s of scored) byCandidate.get(s.attempt.candidateId)?.push(s);
  const perCandidate = candidates.map((c) => {
    const mine = byCandidate.get(c.id)!;
    const finals = mine.filter((s) => s.result?.final);
    const best = finals.sort((x, y) => y.result!.obtained! - x.result!.obtained!)[0] ?? null;
    const submitted = mine.some((s) => SUBMITTED.includes(s.attempt.status));
    return {
      batches: c.learner.batchMemberships.map((m) => m.batch),
      attempted: mine.length > 0,
      submitted,
      pendingEvaluation: submitted && !best,
      best: best ? { obtained: best.result!.obtained!, percentage: best.result!.percentage!, passed: best.result!.passed, row: best } : null,
    };
  });

  function group(list: typeof perCandidate) {
    const finals = list.flatMap((c) => (c.best ? [c.best] : []));
    return {
      candidates: list.length,
      attempted: list.filter((c) => c.attempted).length,
      submitted: list.filter((c) => c.submitted).length,
      evaluated: finals.length,
      pendingEvaluation: list.filter((c) => c.pendingEvaluation).length,
      ...scoreStats(finals),
      /** Only when the assessment sets passing marks; out of the final (fully evaluated) results. */
      passRate: hasPassRule ? rate(finals.filter((f) => f.passed).length, finals.length) : null,
      passed: hasPassRule ? finals.filter((f) => f.passed).length : null,
      /** Candidates with a submitted attempt, out of all candidates. */
      completionRate: rate(list.filter((c) => c.submitted).length, list.length),
    };
  }

  // Operational counts over attempts, by persisted state.
  const count = (pred: (a: (typeof attempts)[number]) => boolean) => attempts.filter(pred).length;
  const inProgress = attempts.filter((a) => a.status === AttemptStatus.IN_PROGRESS);
  const durations = attempts.filter((a) => SUBMITTED.includes(a.status)).map((a) => timeTakenSeconds(a)!);
  const attemptCounts = {
    started: attempts.length,
    inProgress: inProgress.length,
    paused: assessment.status === AssessmentStatus.PAUSED ? inProgress.filter((a) => !a.lockedAt).length : 0,
    locked: inProgress.filter((a) => a.lockedAt).length,
    submitted: count((a) => a.status === AttemptStatus.SUBMITTED),
    autoSubmitted: count((a) => a.status === AttemptStatus.AUTO_SUBMITTED),
    terminated: count((a) => a.status === AttemptStatus.TERMINATED),
    /** Submitted attempts (on time or at the deadline): start to submission, minus pauses. */
    averageDurationSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
  };

  // Question analysis over each candidate's final result (the attempt that counts).
  const finalRows = perCandidate.flatMap((c) => (c.best ? [c.best.row] : []));
  const first = scored.find((s) => s.result) ?? null;
  const numbers = numbering({ assessment });
  const questions = assessment.questions.map((aq, i) => {
    const outcomes = finalRows.map((r) => r.result!.questions[i]);
    const kind = questionKind((aq.snapshot as unknown as QuestionSnapshot).type) === "OBJECTIVE" ? ("objective" as const) : ("subjective" as const);
    const maxMarks = aq.marks.toNumber();
    const n = outcomes.length;
    const total = outcomes.reduce((a, q) => a + (q.awarded ?? 0), 0);
    const objective = kind === "objective";
    return {
      assessmentQuestionId: aq.id,
      number: numbers.get(aq.id)!,
      section: aq.paperQuestion?.section.title ?? null,
      kind,
      maxMarks,
      results: n,
      responses: outcomes.filter((q) => q.outcome !== "unanswered").length,
      unanswered: outcomes.filter((q) => q.outcome === "unanswered").length,
      correct: objective ? outcomes.filter((q) => q.outcome === "correct").length : null,
      incorrect: objective ? outcomes.filter((q) => q.outcome === "incorrect").length : null,
      averageMarks: n ? round2(total / n) : null,
      /** Average share of the question's marks obtained (the classical facility index). */
      averagePercentage: n && maxMarks > 0 ? round2((total / n / maxMarks) * 100) : null,
    };
  });

  // Batch performance: candidates grouped by their batch(es) in the assessment's course.
  const batches = new Map<string, { id: string; name: string; list: typeof perCandidate }>();
  for (const c of perCandidate) {
    for (const b of c.batches) {
      if (!batches.has(b.id)) batches.set(b.id, { ...b, list: [] });
      batches.get(b.id)!.list.push(c);
    }
  }
  const noBatch = perCandidate.filter((c) => c.batches.length === 0);

  return {
    scope: actor.role === Role.ADMIN ? ("ALL" as const) : ("ASSIGNED" as const),
    assessment: { id: assessment.id, name: assessment.name, status: assessment.status, batch: assessment.batch, passingMarks: hasPassRule ? passingMarks : null, maxMarks: first?.result?.maxMarks ?? calculateAttemptResult(resultInputs({ assessment, responses: [] } as unknown as ResultAttemptRow)).maxMarks },
    overview: group(perCandidate),
    attempts: attemptCounts,
    questions,
    batches: [
      ...[...batches.values()].sort((a, b) => a.name.localeCompare(b.name)).map((b) => ({ id: b.id, name: b.name, ...group(b.list) })),
      ...(noBatch.length ? [{ id: null, name: "No batch", ...group(noBatch) }] : []),
    ],
  };
}

export type AssessmentAnalytics = Awaited<ReturnType<typeof getAssessmentAnalytics>>;
