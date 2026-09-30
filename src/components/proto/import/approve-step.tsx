"use client";

import { AlertTriangle, CircleCheck, CircleX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { countWhere, flatten, hasOptions, paperTotals } from "@/prototype/lib/paper";
import type { QuestionPaper } from "@/prototype/types";
import { Panel } from "../page";
import { PaperStats, PaperStructure } from "../paper-summary";
import { validateDetails } from "./details-step";

export function approvalChecks(paper: QuestionPaper) {
  const all = flatten(paper.questions);
  const objective = all.filter((q) => hasOptions(q.type));
  const needsReview = countWhere(paper.questions, (q) => q.needsReview);
  const missingMarks = all.filter((q) => q.children.length === 0 && q.marks <= 0).length;
  const missingAnswers = objective.filter((q) => !q.options.some((o) => o.correct)).length;
  const detailsOk = Object.keys(validateDetails(paper)).length === 0;
  return {
    needsReview,
    items: [
      { label: "Questions parsed", ok: paper.questions.length > 0, detail: `${paper.questions.length} questions` },
      { label: "Sections configured", ok: detailsOk, detail: detailsOk ? `${paper.sections.length} sections with attempt rules` : "Check paper details and section rules" },
      { label: "Marks configured", ok: missingMarks === 0, detail: missingMarks ? `${missingMarks} question${missingMarks === 1 ? "" : "s"} without marks` : `${paperTotals(paper).marks} total marks` },
      { label: "Correct answers detected", ok: missingAnswers === 0, detail: missingAnswers ? `${missingAnswers} objective question${missingAnswers === 1 ? "" : "s"} without an answer` : `${objective.length} objective questions keyed` },
      { label: "No unresolved required fields", ok: needsReview === 0, detail: needsReview ? `${needsReview} question${needsReview === 1 ? "" : "s"} flagged` : "All questions reviewed" },
    ],
  };
}

export function ApproveStep({ paper, onReviewIssues, onEditDetails }: { paper: QuestionPaper; onReviewIssues: () => void; onEditDetails: () => void }) {
  const { items, needsReview } = approvalChecks(paper);
  const ready = items.every((i) => i.ok);
  return (
    <div className="grid gap-6">
      <Panel title={ready ? "Question Paper Ready" : "Almost ready"} description={ready ? "Everything checks out. Approve the paper to make it available for assessments." : "Resolve the items below before approving."}>
        <ul className="grid gap-2">
          {items.map((i) => (
            <li key={i.label} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
              {i.ok ? <CircleCheck className="size-5 shrink-0 text-emerald-600" aria-label="Passed" /> : <CircleX className="size-5 shrink-0 text-destructive" aria-label="Not passed" />}
              <span className="flex-1 text-sm font-medium">{i.label}</span>
              <span className="text-xs text-muted-foreground">{i.detail}</span>
              {!i.ok && i.label === "Sections configured" ? (
                <Button variant="ghost" size="xs" onClick={onEditDetails}>
                  Fix
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {needsReview ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-4 py-3 ring-1 ring-amber-200 ring-inset">
            <span className="flex items-center gap-2 text-sm text-amber-900">
              <AlertTriangle className="size-4" /> {needsReview} question{needsReview === 1 ? "" : "s"} require review
            </span>
            <Button size="sm" variant="outline" onClick={onReviewIssues}>
              Review Issues
            </Button>
          </div>
        ) : null}
      </Panel>
      <Panel title={paper.name} description={`${paper.subject} · ${paper.version}`}>
        <PaperStats paper={paper} />
        <PaperStructure paper={paper} className="mt-4" />
      </Panel>
    </div>
  );
}
