import { CheckCircle2, Clock, Hourglass, XCircle } from "lucide-react";
import type { getMyResult } from "@/server/services/results";

export type MyResult = Awaited<ReturnType<typeof getMyResult>>;

/** What the learner is told while a result isn't available (server component). */
export function ResultStateNote({ state }: { state: MyResult["resultState"] }) {
  if (state === "AVAILABLE") return null;
  const text =
    state === "IN_PROGRESS"
      ? "This attempt is still in progress."
      : state === "TERMINATED"
        ? "This attempt was terminated by the administrator. Your saved responses have been recorded."
        : state === "EVALUATION_PENDING"
        ? "Your written answers are being evaluated. Your result will appear here once it is published."
        : "Evaluation is complete. Your result will appear here when it is published.";
  const Icon = state === "IN_PROGRESS" ? Clock : state === "TERMINATED" ? XCircle : Hourglass;
  return (
    <p className="flex items-center gap-2 rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
      <Icon className="size-4 shrink-0" /> {text}
    </p>
  );
}

export function PassBadge({ passed }: { passed: boolean | null }) {
  if (passed === null) return null;
  return passed ? (
    <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-sm font-medium text-emerald-700">
      <CheckCircle2 className="size-4" /> Passed
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-md bg-red-50 px-2 py-0.5 text-sm font-medium text-red-700">
      <XCircle className="size-4" /> Not passed
    </span>
  );
}
