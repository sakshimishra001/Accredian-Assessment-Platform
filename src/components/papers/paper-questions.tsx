"use client";

import { useState } from "react";
import { cn } from "cn";
import { Panel } from "@/components/proto/page";
import { QuestionView } from "@/components/proto/question-view";
import type { QuestionPaper } from "@/prototype/types";

/** Read-only question list for a paper loaded from the database (already mapped by toViewPaper). */
export function PaperQuestions({ paper, answersByDefault = true }: { paper: QuestionPaper; answersByDefault?: boolean }) {
  const [showAnswers, setShowAnswers] = useState(answersByDefault);
  const [section, setSection] = useState<string>("all");
  const sections = section === "all" ? paper.sections : paper.sections.filter((s) => s.id === section);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Section">
          {[{ id: "all", name: "All sections" }, ...paper.sections].map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={section === s.id}
              onClick={() => setSection(s.id)}
              className={cn("rounded-md px-2.5 py-1 text-xs font-medium", section === s.id ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground ring-1 ring-border hover:bg-muted")}
            >
              {s.name}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showAnswers} onChange={(e) => setShowAnswers(e.target.checked)} className="size-4 accent-[var(--primary)]" />
          Show answer key
        </label>
      </div>

      {sections.map((s) => {
        const questions = paper.questions.filter((q) => q.sectionId === s.id);
        return (
          <Panel key={s.id} title={s.name} description={`${s.range} · ${s.marks} marks`}>
            <div className="grid gap-6">
              {questions.map((q) => (
                <QuestionView key={q.id} q={q} showAnswers={showAnswers} />
              ))}
              {questions.length === 0 ? <p className="text-sm text-muted-foreground">No questions in this section.</p> : null}
            </div>
          </Panel>
        );
      })}
    </>
  );
}
