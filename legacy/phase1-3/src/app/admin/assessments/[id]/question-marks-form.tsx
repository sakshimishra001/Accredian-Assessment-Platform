"use client";

import { useFormSubmit } from "@/components/shared/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult, FormState } from "@/server/action-result";

/** Inline marks / negative-marks editor for one question in a draft assessment. */
export function QuestionMarksForm({
  action,
  marks,
  negativeMarks,
  allowNegative,
}: {
  action: (prev: FormState, formData: FormData) => Promise<ActionResult>;
  marks: number;
  negativeMarks: number;
  allowNegative: boolean;
}) {
  const [state, onSubmit, pending] = useFormSubmit<FormState>(action, null);
  const error = state && !state.ok ? (state.fieldErrors?.negativeMarks?.[0] ?? state.fieldErrors?.marks?.[0] ?? state.error) : null;

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-1.5 text-xs">
      <label className="flex items-center gap-1">
        <span className="text-muted-foreground">Marks</span>
        <Input name="marks" type="number" min={0} step="0.25" defaultValue={marks} className="h-7 w-18" aria-label="Marks" />
      </label>
      {allowNegative ? (
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">−ve</span>
          <Input name="negativeMarks" type="number" min={0} step="0.25" defaultValue={negativeMarks} className="h-7 w-18" aria-label="Negative marks" />
        </label>
      ) : (
        <input type="hidden" name="negativeMarks" value="0" />
      )}
      <Button type="submit" size="xs" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
      {error ? <span className="text-destructive">{error}</span> : state?.ok ? <span className="text-muted-foreground">Saved</span> : null}
    </form>
  );
}
