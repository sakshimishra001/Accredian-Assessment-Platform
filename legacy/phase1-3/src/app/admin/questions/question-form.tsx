"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Field, FormMessage, SubmitButton, useFormSubmit } from "@/components/shared/form";
import { buttonVariants, Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { Difficulty, QuestionType } from "@/generated/prisma/enums";
import { ALL_QUESTION_TYPES, hasOptions, QUESTION_TYPES } from "@/lib/questions/types";
import { MAX_OPTIONS, MIN_OPTIONS } from "@/lib/validation/question";
import type { ActionResult, FormState } from "@/server/action-result";

export interface QuestionFormValues {
  type: QuestionType;
  text: string;
  guidance: string | null;
  marks: number;
  negativeMarks: number;
  topic: string | null;
  difficulty: Difficulty;
  courseId: string | null;
  options: { text: string; isCorrect: boolean }[];
}

const DIFFICULTIES: { value: Difficulty; label: string }[] = [
  { value: "EASY", label: "Easy" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HARD", label: "Hard" },
];

const blankOptions = () => [
  { text: "", isCorrect: false },
  { text: "", isCorrect: false },
  { text: "", isCorrect: false },
  { text: "", isCorrect: false },
];

export function QuestionForm({
  action,
  initial,
  courses,
  cancelHref,
  submitLabel,
  usageNote,
}: {
  action: (prev: FormState, formData: FormData) => Promise<ActionResult>;
  initial?: QuestionFormValues;
  courses: { id: string; code: string; name: string }[];
  cancelHref: string;
  submitLabel: string;
  usageNote?: string;
}) {
  const [state, onSubmit, pending] = useFormSubmit<FormState>(action, null);
  const [type, setType] = useState<QuestionType>(initial?.type ?? "MCQ_SINGLE");
  const [options, setOptions] = useState(
    initial && initial.type !== "TRUE_FALSE" && initial.options.length ? initial.options : blankOptions(),
  );
  const [trueIsCorrect, setTrueIsCorrect] = useState<boolean | null>(
    initial?.type === "TRUE_FALSE" ? (initial.options[0]?.isCorrect ?? null) : null,
  );
  const errors = state && !state.ok ? state.fieldErrors ?? {} : {};
  const objective = hasOptions(type);

  const serializedOptions =
    type === "TRUE_FALSE"
      ? trueIsCorrect === null
        ? []
        : [
            { text: "True", isCorrect: trueIsCorrect },
            { text: "False", isCorrect: !trueIsCorrect },
          ]
      : objective
        ? options
        : [];

  function setCorrect(index: number, checked: boolean) {
    setOptions((prev) =>
      prev.map((o, i) =>
        type === "MCQ_SINGLE" ? { ...o, isCorrect: i === index } : i === index ? { ...o, isCorrect: checked } : o,
      ),
    );
  }

  function changeType(next: QuestionType) {
    setType(next);
    // A single-answer MCQ can only keep one correct option.
    if (next === "MCQ_SINGLE") {
      setOptions((prev) => {
        const first = prev.findIndex((o) => o.isCorrect);
        return prev.map((o, i) => ({ ...o, isCorrect: i === first }));
      });
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-6" noValidate>
      <FormMessage state={state} />
      {usageNote ? <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{usageNote}</p> : null}
      <input type="hidden" name="options" value={JSON.stringify(serializedOptions)} />

      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Question type" htmlFor="type" error={errors.type}>
          <NativeSelect id="type" name="type" value={type} onChange={(e) => changeType(e.target.value as QuestionType)} className="w-full">
            {ALL_QUESTION_TYPES.map((t) => (
              <NativeSelectOption key={t} value={t}>
                {QUESTION_TYPES[t].label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Difficulty" htmlFor="difficulty" error={errors.difficulty}>
          <NativeSelect id="difficulty" name="difficulty" defaultValue={initial?.difficulty ?? "MEDIUM"} className="w-full">
            {DIFFICULTIES.map((d) => (
              <NativeSelectOption key={d.value} value={d.value}>
                {d.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Topic" htmlFor="topic" error={errors.topic} hint="e.g. Probability, SQL joins">
          <Input id="topic" name="topic" defaultValue={initial?.topic ?? ""} maxLength={100} />
        </Field>
      </div>

      <Field label="Question text" htmlFor="text" error={errors.text}>
        <Textarea id="text" name="text" rows={4} defaultValue={initial?.text ?? ""} aria-invalid={errors.text ? true : undefined} />
      </Field>

      {type === "TRUE_FALSE" ? (
        <Field label="Correct answer" error={errors.options}>
          <div className="flex gap-3" role="radiogroup">
            {[true, false].map((value) => (
              <label key={String(value)} className="flex cursor-pointer items-center gap-2 rounded-md border px-4 py-2 text-sm has-checked:border-primary has-checked:bg-muted">
                <input type="radio" name="tf" checked={trueIsCorrect === value} onChange={() => setTrueIsCorrect(value)} />
                {value ? "True" : "False"}
              </label>
            ))}
          </div>
        </Field>
      ) : objective ? (
        <Field
          label={type === "MCQ_SINGLE" ? "Options — select the one correct answer" : "Options — tick every correct answer"}
          error={errors.options}
        >
          <ul className="grid gap-2">
            {options.map((o, i) => (
              <li key={i} className="flex items-center gap-2">
                <input
                  type={type === "MCQ_SINGLE" ? "radio" : "checkbox"}
                  name="correct"
                  aria-label={`Option ${i + 1} is correct`}
                  checked={o.isCorrect}
                  onChange={(e) => setCorrect(i, e.target.checked)}
                  className="size-4 shrink-0"
                />
                <Input
                  aria-label={`Option ${i + 1}`}
                  placeholder={`Option ${i + 1}`}
                  value={o.text}
                  maxLength={1000}
                  onChange={(e) => setOptions((prev) => prev.map((p, j) => (j === i ? { ...p, text: e.target.value } : p)))}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove option ${i + 1}`}
                  disabled={options.length <= MIN_OPTIONS}
                  onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={options.length >= MAX_OPTIONS}
              onClick={() => setOptions((prev) => [...prev, { text: "", isCorrect: false }])}
            >
              <Plus /> Add option
            </Button>
          </div>
        </Field>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Marks" htmlFor="marks" error={errors.marks}>
          <Input id="marks" name="marks" type="number" min={0} step="0.25" defaultValue={initial?.marks ?? 1} />
        </Field>
        {objective ? (
          <Field label="Negative marks" htmlFor="negativeMarks" error={errors.negativeMarks} hint="Deducted for a wrong answer. 0 for none.">
            <Input id="negativeMarks" name="negativeMarks" type="number" min={0} step="0.25" defaultValue={initial?.negativeMarks ?? 0} />
          </Field>
        ) : null}
        <Field label="Course (optional)" htmlFor="courseId" error={errors.courseId}>
          <NativeSelect id="courseId" name="courseId" defaultValue={initial?.courseId ?? ""} className="w-full">
            <NativeSelectOption value="">Any course</NativeSelectOption>
            {courses.map((c) => (
              <NativeSelectOption key={c.id} value={c.id}>
                {c.code} — {c.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <Field
        label={objective ? "Explanation (optional)" : "Marking guidance (optional)"}
        htmlFor="guidance"
        error={errors.guidance}
        hint={objective ? "Shown to admins; can be shown to learners with results later." : "Model answer or rubric for examiners."}
      >
        <Textarea id="guidance" name="guidance" rows={3} defaultValue={initial?.guidance ?? ""} />
      </Field>

      <div className="flex gap-2">
        <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
        <Link href={cancelHref} className={buttonVariants({ variant: "ghost" })}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
