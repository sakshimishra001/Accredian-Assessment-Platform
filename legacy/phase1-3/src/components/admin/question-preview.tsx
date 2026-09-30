import { CircleCheck, Circle, Square, SquareCheck } from "lucide-react";
import { cn } from "cn";
import type { QuestionType } from "@/generated/prisma/enums";
import { hasOptions } from "@/lib/questions/types";

/** Read-only rendering of a question as an admin sees it, with correct answers highlighted. */
export function QuestionPreview({
  type,
  text,
  options,
  guidance,
  compact = false,
}: {
  type: QuestionType;
  text: string;
  options: { id?: string; text: string; isCorrect: boolean }[];
  guidance?: string | null;
  compact?: boolean;
}) {
  const multi = type === "MCQ_MULTI";
  return (
    <div className="grid gap-3">
      <p className={cn("whitespace-pre-wrap", compact ? "text-sm" : "text-base")}>{text}</p>
      {hasOptions(type) ? (
        <ul className="grid gap-1.5">
          {options.map((o, i) => {
            const Icon = multi ? (o.isCorrect ? SquareCheck : Square) : o.isCorrect ? CircleCheck : Circle;
            return (
              <li
                key={o.id ?? i}
                className={cn(
                  "flex items-start gap-2 rounded-md border px-3 py-1.5 text-sm",
                  o.isCorrect && "border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950",
                )}
              >
                <Icon className={cn("mt-0.5 size-4 shrink-0", o.isCorrect ? "text-green-700 dark:text-green-400" : "text-muted-foreground")} aria-hidden />
                <span className="flex-1">{o.text}</span>
                {o.isCorrect ? <span className="text-xs font-medium text-green-700 dark:text-green-400">Correct</span> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          {type === "LONG_ANSWER" ? "Learner writes a long-form answer." : "Learner writes a short answer."}
        </div>
      )}
      {guidance && !compact ? (
        <div className="rounded-md bg-muted/60 px-3 py-2 text-sm">
          <div className="mb-0.5 text-xs font-medium text-muted-foreground uppercase">
            {hasOptions(type) ? "Explanation" : "Marking guidance"}
          </div>
          <p className="whitespace-pre-wrap">{guidance}</p>
        </div>
      ) : null}
    </div>
  );
}
