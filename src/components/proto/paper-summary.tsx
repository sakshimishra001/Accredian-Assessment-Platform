"use client";

import { cn } from "cn";
import { paperTotals, ruleText, sectionQuestions } from "@/prototype/lib/paper";
import type { QuestionPaper } from "@/prototype/types";

/** Section-by-section structure of a question paper: rule, question count and marks. */
export function PaperStructure({ paper, className }: { paper: QuestionPaper; className?: string }) {
  const totals = paperTotals(paper);
  return (
    <div className={cn("overflow-hidden rounded-lg border", className)}>
      <table className="w-full text-sm">
        <thead className="bg-muted/60 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Section</th>
            <th className="px-3 py-2 text-left font-medium">Questions</th>
            <th className="px-3 py-2 text-left font-medium">Attempt rule</th>
            <th className="px-3 py-2 text-right font-medium">Marks</th>
          </tr>
        </thead>
        <tbody>
          {paper.sections.map((s) => {
            const count = sectionQuestions(paper, s.id).length;
            return (
              <tr key={s.id} className="border-t">
                <td className="px-3 py-2 font-medium">{s.name}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {count} · {s.range}
                </td>
                <td className="px-3 py-2">
                  <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", s.rule === "COMPULSORY" ? "bg-muted text-foreground" : "bg-accent text-accent-foreground")}>
                    {ruleText(s, count)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{s.marks}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t bg-muted/40 font-medium">
            <td className="px-3 py-2">Total</td>
            <td className="px-3 py-2 text-muted-foreground">{totals.questions} questions</td>
            <td className="px-3 py-2" />
            <td className="px-3 py-2 text-right tabular-nums">{totals.marks} marks</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function PaperStats({ paper }: { paper: QuestionPaper }) {
  const t = paperTotals(paper);
  const items = [
    [t.questions, "Questions"],
    [t.sections, "Sections"],
    [t.marks, "Marks"],
    [t.objective, "Objective"],
    [t.subjective, "Subjective"],
  ] as const;
  return (
    <dl className="grid grid-cols-3 gap-3 sm:grid-cols-5">
      {items.map(([v, l]) => (
        <div key={l} className="rounded-lg border bg-background px-3 py-2">
          <dt className="text-xs text-muted-foreground">{l}</dt>
          <dd className="text-lg font-semibold tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
