import "server-only";
import { EvaluationStatus } from "@/generated/prisma/enums";
import type { QuestionSnapshot } from "@/lib/questions/snapshot";
import { hasOptions } from "@/lib/questions/types";
import type { DbTx } from "../db";

/** A written answer that an examiner must mark: a subjective question with text or an uploaded file. */
export function needsManualMarks(snapshot: Pick<QuestionSnapshot, "type">, textAnswer: string | null, fileCount = 0) {
  return !hasOptions(snapshot.type) && (!!textAnswer?.trim() || fileCount > 0);
}

/**
 * Set an attempt's evaluation status when it is submitted (manually or at the deadline): PENDING
 * if any written answer needs marks, otherwise COMPLETED straight away (objective questions are
 * scored automatically; unanswered subjective questions score 0 and need no examiner).
 */
export async function setInitialEvaluationStatus(tx: DbTx, attemptId: string, now: Date) {
  const responses = await tx.attemptResponse.findMany({
    where: { attemptId },
    select: { textAnswer: true, assessmentQuestion: { select: { snapshot: true } }, _count: { select: { attachments: true } } },
  });
  const pending = responses.some((r) => needsManualMarks(r.assessmentQuestion.snapshot as unknown as QuestionSnapshot, r.textAnswer, r._count.attachments));
  await tx.assessmentAttempt.update({
    where: { id: attemptId },
    data: pending ? { evaluationStatus: EvaluationStatus.PENDING } : { evaluationStatus: EvaluationStatus.COMPLETED, evaluationFinalizedAt: now },
  });
}
