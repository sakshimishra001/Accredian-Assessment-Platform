"use client";

import { AlertTriangle, CircleCheck } from "lucide-react";
import { cn } from "cn";
import { hasOptions, QUESTION_TYPE_LABEL } from "@/prototype/lib/paper";
import type { Question } from "@/prototype/types";
import { hasConfigurableResponse } from "@/prototype/lib/response";
import { FileChip } from "@/components/files/file-preview";
import { responseSummary } from "./response-config";
import { Tag } from "./status-badge";

/**
 * Read-only question rendering used in the paper viewer. Shows passages for
 * comprehension/case-study groups and nests sub-questions visually.
 */
export function QuestionView({
  q,
  showAnswers = true,
  depth = 0,
  hideMaterials = false,
}: {
  q: Question;
  showAnswers?: boolean;
  depth?: number;
  /** The review screen renders materials separately (with add/remove). */
  hideMaterials?: boolean;
}) {
  return (
    <div className={cn(depth > 0 && "border-l-2 border-primary/20 pl-4")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold tabular-nums">Q{q.number}</span>
        <Tag>{QUESTION_TYPE_LABEL[q.type]}</Tag>
        {!q.compulsory && depth === 0 ? <Tag>Optional</Tag> : null}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {q.marks} mark{q.marks === 1 ? "" : "s"}
        </span>
        {q.needsReview ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
            <AlertTriangle className="size-3.5" /> Needs review
          </span>
        ) : null}
      </div>
      {q.passage ? (
        <div className="mt-2 rounded-md border bg-muted/40 px-3 py-2 text-sm leading-relaxed">
          <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {q.type === "CASE_STUDY" ? "Case" : "Passage"}
          </div>
          {q.passage}
        </div>
      ) : null}
      <p className="mt-2 text-sm leading-relaxed whitespace-pre-line">{q.text || <span className="text-muted-foreground italic">No question text</span>}</p>
      {hasOptions(q.type) ? (
        <ul className="mt-2 grid gap-1.5">
          {q.options.map((o, i) => (
            <li
              key={o.id}
              className={cn(
                "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-sm",
                showAnswers && o.correct && "border-emerald-300 bg-emerald-50",
              )}
            >
              <span className="w-4 shrink-0 text-xs font-medium text-muted-foreground">{String.fromCharCode(65 + i)}</span>
              <span className="flex-1">{o.text || <span className="text-muted-foreground italic">Empty option</span>}</span>
              {showAnswers && o.correct ? <CircleCheck className="size-4 shrink-0 text-emerald-600" aria-label="Correct answer" /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {hasConfigurableResponse(q) && q.response && q.response.type !== "text" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Learner response:</span> {responseSummary(q.response)}
        </p>
      ) : null}
      {q.materials?.length && !hideMaterials ? (
        <div className="mt-3">
          <p className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Supporting material</p>
          <div className="grid gap-1.5">
            {q.materials.map((m) => (
              <FileChip key={m.id} file={{ id: m.id, fileName: m.name, extension: m.ext, sizeBytes: Math.round(m.sizeKb * 1024) }} description={m.description} />
            ))}
          </div>
        </div>
      ) : null}
      {q.children.length ? (
        <div className="mt-3 grid gap-4">
          {q.children.map((c) => (
            <QuestionView key={c.id} q={c} showAnswers={showAnswers} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
