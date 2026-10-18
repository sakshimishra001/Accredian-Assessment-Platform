/*
 * How a learner's own attempt is found, everywhere it is looked up by id (save, submit, clock,
 * proctoring events, answer files, results). The attempt must belong to the signed-in learner; the
 * attempt itself says which assessment it is in. It is never narrowed by a request's or session's
 * assessment: a learner session isn't tied to one assessment (and a legacy exam-password session's
 * default assessment may be a different one than the attempt's), so narrowing by it would make the
 * learner's own running attempt "not found".
 */

/** The where-clause for "this learner's attempt with this id". */
export function ownAttemptWhere(learnerId: string, attemptId: string) {
  return { id: attemptId, learnerId };
}
