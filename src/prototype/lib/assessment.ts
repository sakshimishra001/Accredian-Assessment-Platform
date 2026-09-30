import type { ResultVisibility } from "../types";

export const RESULT_VISIBILITY_LABEL: Record<ResultVisibility, string> = {
  score: "Score only",
  score_answers: "Score and correct answers",
  full_feedback: "Score, answers and examiner feedback",
};
