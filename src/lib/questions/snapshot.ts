import type { Difficulty, QuestionType } from "@/generated/prisma/enums";

/**
 * Frozen copy of a question stored on AssessmentQuestion when the question is added.
 * Edits in the bank never change it; it is only replaced when an admin explicitly pulls
 * the latest version into a draft assessment.
 */
export interface QuestionSnapshot {
  questionId: string;
  /** Question.version this copy was taken from. */
  version: number;
  type: QuestionType;
  text: string;
  guidance: string | null;
  topic: string | null;
  difficulty: Difficulty;
  options: { id: string; text: string; isCorrect: boolean; position: number }[];
}

export function buildSnapshot(q: {
  id: string;
  version: number;
  type: QuestionType;
  text: string;
  guidance: string | null;
  topic: string | null;
  difficulty: Difficulty;
  options: { id: string; text: string; isCorrect: boolean; position: number }[];
}): QuestionSnapshot {
  return {
    questionId: q.id,
    version: q.version,
    type: q.type,
    text: q.text,
    guidance: q.guidance,
    topic: q.topic,
    difficulty: q.difficulty,
    options: [...q.options]
      .sort((a, b) => a.position - b.position)
      .map(({ id, text, isCorrect, position }) => ({ id, text, isCorrect, position })),
  };
}

/** Whether a snapshot's content differs from what `buildSnapshot` would produce now (ignoring option ids). */
export function snapshotDiffers(a: QuestionSnapshot, b: QuestionSnapshot): boolean {
  const strip = (s: QuestionSnapshot) =>
    JSON.stringify([s.type, s.text, s.guidance, s.topic, s.difficulty, s.options.map((o) => [o.text, o.isCorrect])]);
  return strip(a) !== strip(b);
}
