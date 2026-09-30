import type { ReactNode } from "react";
import { cn } from "cn";
import type { AssessmentStatus, Difficulty, QuestionType } from "@/generated/prisma/enums";
import { STATUS_LABEL } from "@/lib/assessments/lifecycle";
import { QUESTION_TYPES } from "@/lib/questions/types";

const STATUS_TONE: Record<AssessmentStatus, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SCHEDULED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  ACTIVE: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
  ENDED: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  EVALUATION: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200",
  RESULT_READY: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200",
  PUBLISHED: "bg-emerald-600 text-white",
  ARCHIVED: "bg-muted text-muted-foreground line-through",
};

function Pill({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap", className)}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: AssessmentStatus }) {
  return <Pill className={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>;
}

export function QuestionTypeBadge({ type }: { type: QuestionType }) {
  const kind = QUESTION_TYPES[type].kind;
  return (
    <Pill className={kind === "OBJECTIVE" ? "bg-sky-50 text-sky-800 ring-1 ring-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-800" : "bg-orange-50 text-orange-800 ring-1 ring-orange-200 dark:bg-orange-950 dark:text-orange-200 dark:ring-orange-800"}>
      {QUESTION_TYPES[type].label}
    </Pill>
  );
}

const DIFFICULTY_TONE: Record<Difficulty, string> = {
  EASY: "text-green-700 dark:text-green-400",
  MEDIUM: "text-amber-700 dark:text-amber-400",
  HARD: "text-red-700 dark:text-red-400",
};

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { EASY: "Easy", MEDIUM: "Medium", HARD: "Hard" };

export function DifficultyLabel({ difficulty }: { difficulty: Difficulty }) {
  return <span className={cn("text-xs font-medium", DIFFICULTY_TONE[difficulty])}>{DIFFICULTY_LABEL[difficulty]}</span>;
}

/** Question bank status. Stored as `isArchived`; shown as Inactive. */
export function InactiveBadge() {
  return <Pill className="bg-muted text-muted-foreground">Inactive</Pill>;
}

export function VersionTag({ version }: { version: number }) {
  return <span className="font-mono text-xs text-muted-foreground">v{version}</span>;
}
