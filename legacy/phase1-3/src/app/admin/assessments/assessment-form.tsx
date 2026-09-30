"use client";

import Link from "next/link";
import { useState } from "react";
import { Field, FormMessage, SubmitButton, useFormSubmit } from "@/components/shared/form";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { AssessmentType, ResultVisibility } from "@/generated/prisma/enums";
import type { AssessmentField } from "@/lib/assessments/lifecycle";
import { ASSESSMENT_TYPE_LABEL, MAX_ATTEMPTS_LIMIT, MAX_DURATION_MINUTES, RESULT_VISIBILITY_LABEL } from "@/lib/validation/assessment";
import type { ActionResult, FormState } from "@/server/action-result";

export interface AssessmentFormValues {
  name: string;
  description: string | null;
  courseId: string;
  type: AssessmentType;
  durationMinutes: number;
  /** IST datetime-local strings */
  startAt: string;
  endAt: string;
  maxAttempts: number;
  passingMarks: number;
  resultVisibility: ResultVisibility;
  proctoringEnabled: boolean;
}

export function AssessmentForm({
  action,
  initial,
  courses,
  editable,
  cancelHref,
  submitLabel,
  totalMarks,
}: {
  action: (prev: FormState, formData: FormData) => Promise<ActionResult>;
  initial: AssessmentFormValues;
  courses: { id: string; code: string; name: string }[];
  /** Fields the current status allows changing; others render read-only and are not submitted. */
  editable: readonly AssessmentField[];
  cancelHref: string;
  submitLabel: string;
  totalMarks?: number;
}) {
  const [state, onSubmit, pending] = useFormSubmit<FormState>(action, null);
  const [type, setType] = useState<AssessmentType>(initial.type);
  const errors = state && !state.ok ? state.fieldErrors ?? {} : {};
  const locked = (f: AssessmentField) => !editable.includes(f);
  const lockHint = (f: AssessmentField) => (locked(f) ? "Locked in the current status" : undefined);

  return (
    <form onSubmit={onSubmit} className="grid gap-6" noValidate>
      <FormMessage state={state} />

      <section className="grid gap-4">
        <h2 className="text-sm font-semibold">Basics</h2>
        <Field label="Name" htmlFor="name" error={errors.name} hint={lockHint("name")}>
          <Input id="name" name="name" defaultValue={initial.name} disabled={locked("name")} maxLength={200} />
        </Field>
        <Field label="Description" htmlFor="description" error={errors.description} hint={lockHint("description") ?? "Instructions shown to learners before they start."}>
          <Textarea id="description" name="description" rows={3} defaultValue={initial.description ?? ""} disabled={locked("description")} />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Course" htmlFor="courseId" error={errors.courseId} hint={lockHint("courseId")}>
            <NativeSelect id="courseId" name="courseId" defaultValue={initial.courseId} disabled={locked("courseId")} className="w-full">
              <NativeSelectOption value="" disabled>
                Choose a course…
              </NativeSelectOption>
              {courses.map((c) => (
                <NativeSelectOption key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Assessment type" htmlFor="type" error={errors.type} hint={lockHint("type") ?? "Limits which question types can be added."}>
            <NativeSelect
              id="type"
              name="type"
              value={type}
              onChange={(e) => setType(e.target.value as AssessmentType)}
              disabled={locked("type")}
              className="w-full"
            >
              {(Object.keys(ASSESSMENT_TYPE_LABEL) as AssessmentType[]).map((t) => (
                <NativeSelectOption key={t} value={t}>
                  {ASSESSMENT_TYPE_LABEL[t]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>
      </section>

      <section className="grid gap-4">
        <h2 className="text-sm font-semibold">Schedule <span className="font-normal text-muted-foreground">(IST)</span></h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Start" htmlFor="startAt" error={errors.startAt} hint={lockHint("startAt")}>
            <Input id="startAt" name="startAt" type="datetime-local" defaultValue={initial.startAt} disabled={locked("startAt")} />
          </Field>
          <Field label="End" htmlFor="endAt" error={errors.endAt} hint={lockHint("endAt")}>
            <Input id="endAt" name="endAt" type="datetime-local" defaultValue={initial.endAt} disabled={locked("endAt")} />
          </Field>
          <Field label="Duration (minutes)" htmlFor="durationMinutes" error={errors.durationMinutes} hint={lockHint("durationMinutes") ?? "Time each learner gets once they start."}>
            <Input id="durationMinutes" name="durationMinutes" type="number" min={1} max={MAX_DURATION_MINUTES} defaultValue={initial.durationMinutes} disabled={locked("durationMinutes")} />
          </Field>
        </div>
      </section>

      <section className="grid gap-4">
        <h2 className="text-sm font-semibold">Rules</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Maximum attempts" htmlFor="maxAttempts" error={errors.maxAttempts} hint={lockHint("maxAttempts") ?? "Per learner."}>
            <Input id="maxAttempts" name="maxAttempts" type="number" min={1} max={MAX_ATTEMPTS_LIMIT} defaultValue={initial.maxAttempts} disabled={locked("maxAttempts")} />
          </Field>
          <Field
            label="Passing marks"
            htmlFor="passingMarks"
            error={errors.passingMarks}
            hint={lockHint("passingMarks") ?? (totalMarks !== undefined ? `Total marks currently ${totalMarks}.` : "Must not exceed total marks when scheduling.")}
          >
            <Input id="passingMarks" name="passingMarks" type="number" min={0} step="0.25" defaultValue={initial.passingMarks} disabled={locked("passingMarks")} />
          </Field>
          <Field label="Result visibility" htmlFor="resultVisibility" error={errors.resultVisibility} hint={lockHint("resultVisibility")}>
            <NativeSelect id="resultVisibility" name="resultVisibility" defaultValue={initial.resultVisibility} disabled={locked("resultVisibility")} className="w-full">
              {(Object.keys(RESULT_VISIBILITY_LABEL) as ResultVisibility[]).map((v) => (
                <NativeSelectOption key={v} value={v} disabled={v === "IMMEDIATE" && type !== "OBJECTIVE"}>
                  {RESULT_VISIBILITY_LABEL[v]}
                  {v === "IMMEDIATE" && type !== "OBJECTIVE" ? " (objective only)" : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Field label="Proctoring" error={errors.proctoringEnabled} hint={lockHint("proctoringEnabled") ?? "Records browser events via the proctoring provider. No AI proctoring in V1."}>
          <label className="flex items-center gap-2 text-sm">
            {/* Hidden fallback so unticking is submitted as "false"; omitted when locked so the value is left unchanged. */}
            {!locked("proctoringEnabled") ? <input type="hidden" name="proctoringEnabled" value="false" /> : null}
            <input type="checkbox" name="proctoringEnabled" defaultChecked={initial.proctoringEnabled} disabled={locked("proctoringEnabled")} className="size-4" />
            Enable proctoring for this assessment
          </label>
        </Field>
      </section>

      <div className="flex gap-2">
        <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
        <Link href={cancelHref} className={buttonVariants({ variant: "ghost" })}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
