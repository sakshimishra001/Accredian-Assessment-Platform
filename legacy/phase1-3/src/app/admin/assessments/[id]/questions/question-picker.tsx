"use client";

import Link from "next/link";
import { useState } from "react";
import { DifficultyLabel, QuestionTypeBadge } from "@/components/admin/badges";
import { FormMessage, SubmitButton, useFormSubmit } from "@/components/shared/form";
import { buttonVariants } from "@/components/ui/button";
import type { Difficulty, QuestionType } from "@/generated/prisma/enums";
import type { ActionResult, FormState } from "@/server/action-result";

interface Row {
  id: string;
  type: QuestionType;
  text: string;
  marks: number;
  negativeMarks: number;
  topic: string | null;
  difficulty: Difficulty;
}

export function QuestionPicker({
  rows,
  action,
  cancelHref,
}: {
  rows: Row[];
  action: (prev: FormState, formData: FormData) => Promise<ActionResult>;
  cancelHref: string;
}) {
  const [state, onSubmit, pending] = useFormSubmit<FormState>(action, null);
  const [selected, setSelected] = useState<string[]>([]);
  const selectedMarks = rows.filter((r) => selected.includes(r.id)).reduce((n, r) => n + r.marks, 0);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <FormMessage state={state} />
      {selected.map((id) => (
        <input key={id} type="hidden" name="questionIds" value={id} />
      ))}

      <div className="flex items-center justify-between gap-2 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="size-4"
            checked={rows.length > 0 && selected.length === rows.length}
            onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])}
            aria-label="Select all"
          />
          Select all shown
        </label>
        <span className="text-muted-foreground">
          {selected.length} selected · {selectedMarks} marks
        </span>
      </div>

      <ul className="grid gap-2">
        {rows.map((r) => (
          <li key={r.id}>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-checked:border-primary has-checked:bg-muted/50">
              <input type="checkbox" className="mt-1 size-4" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} />
              <span className="grid flex-1 gap-1">
                <span className="line-clamp-2 text-sm">{r.text}</span>
                <span className="flex flex-wrap items-center gap-2">
                  <QuestionTypeBadge type={r.type} />
                  <DifficultyLabel difficulty={r.difficulty} />
                  {r.topic ? <span className="text-xs text-muted-foreground">{r.topic}</span> : null}
                  <span className="ml-auto text-xs tabular-nums">
                    {r.marks} marks{r.negativeMarks > 0 ? ` · −${r.negativeMarks}` : ""}
                  </span>
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <SubmitButton pending={pending} pendingText="Adding…">
          Add {selected.length || ""} question{selected.length === 1 ? "" : "s"}
        </SubmitButton>
        <Link href={cancelHref} className={buttonVariants({ variant: "ghost" })}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
