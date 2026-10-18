"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, FilePlus2, Loader2, Upload } from "lucide-react";
import { Field, SelectField, Stepper } from "@/components/proto/controls";
import { IMPORT_METHODS, type ImportMethodKey } from "@/components/proto/import-methods";
import { PageHeader, Panel } from "@/components/proto/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/prototype/toast";
import { createPaperAction, createPaperFromImportAction, previewImportAction, type ImportPreview } from "@/server/actions/question-papers";

export const STEPS = ["Import method", "Paper details", "Review & edit", "Finish"];
type FieldErrors = Record<string, string[] | undefined>;

const ACCEPT: Record<ImportMethodKey, string> = { excel: ".csv", word: ".docx,.doc", pdf: ".pdf" };

export function ImportIssues({ issues }: { issues: string[] }) {
  if (!issues.length) return null;
  return (
    <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset" role="alert">
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4" /> {issues.length} problem{issues.length === 1 ? "" : "s"} found — nothing has been saved. Fix the file and upload it again.
      </p>
      <ul className="mt-2 max-h-56 list-disc overflow-auto pl-6 text-xs">
        {issues.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </div>
  );
}

export const issueText = (i: ImportPreview["issues"][number]) => `${i.row ? `Row ${i.row}` : "File"}${i.field ? ` · ${i.field}` : ""}: ${i.message}`;

/** Choose a file and parse it on the server. Nothing is saved until the paper is created. */
export function ImportUpload({
  method,
  onParsed,
  preview,
}: {
  method: ImportMethodKey;
  onParsed: (p: { preview: ImportPreview; file: { fileName: string; content: string } } | null) => void;
  preview: ImportPreview | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function pick(f: File | undefined) {
    if (!f) return;
    const content = await f.text();
    setError(null);
    onParsed(null);
    startTransition(async () => {
      const result = await previewImportAction({ fileName: f.name, content });
      if (!result.ok) return setError(result.error);
      onParsed({ preview: result.data!, file: { fileName: f.name, content } });
    });
    if (input.current) input.current.value = "";
  }

  return (
    <div className="grid gap-4">
      <input ref={input} type="file" accept={ACCEPT[method]} className="sr-only" aria-label="Question paper file" onChange={(e) => pick(e.target.files?.[0])} />
      {!preview ? (
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">{pending ? <Loader2 className="size-6 animate-spin" /> : <Upload className="size-6" />}</span>
          <p className="mt-3 text-sm font-medium">{pending ? "Reading and validating…" : method === "excel" ? "Choose the filled-in template, saved as CSV" : `Choose a ${ACCEPT[method]} file`}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {method === "excel" ? "In Excel: File → Save As → “CSV UTF-8”. Up to 2 MB." : "Word and PDF import aren’t supported yet; the file will be checked and you’ll be told how to proceed."}
          </p>
          <Button className="mt-4" onClick={() => input.current?.click()} disabled={pending}>
            <Upload /> Choose file
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-destructive ring-1 ring-red-200 ring-inset">
          {error}
        </p>
      ) : null}
      {preview ? (
        <div className="grid gap-3">
          <div className="flex items-start gap-3 rounded-lg border px-4 py-3">
            {preview.issues.length ? <AlertTriangle className="mt-0.5 size-5 text-amber-600" /> : <CheckCircle2 className="mt-0.5 size-5 text-emerald-600" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{preview.fileName}</p>
              <p className="text-sm text-muted-foreground">
                {preview.summary.questions} questions · {preview.summary.sections} sections · {preview.summary.groups} case/passage groups
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => input.current?.click()} disabled={pending}>
              Replace file
            </Button>
          </div>
          {preview.sections.length ? (
            <ul className="grid gap-1 rounded-lg bg-muted/50 px-4 py-2 text-sm">
              {preview.sections.map((s) => (
                <li key={s.title} className="flex justify-between gap-2">
                  <span>{s.title}</span>
                  <span className="tabular-nums text-muted-foreground">{s.questions} questions</span>
                </li>
              ))}
            </ul>
          ) : null}
          <ImportIssues issues={preview.issues.map(issueText)} />
        </div>
      ) : null}
    </div>
  );
}

export function NewPaperView({ courses, initialMethod }: { courses: { id: string; code: string; name: string }[]; initialMethod: ImportMethodKey | "manual" | null }) {
  const router = useRouter();
  const toast = useToast();
  const [method, setMethod] = useState<ImportMethodKey | "manual" | null>(initialMethod);
  const [step, setStep] = useState(initialMethod === "manual" ? 1 : 0);
  const [parsed, setParsed] = useState<{ preview: ImportPreview; file: { fileName: string; content: string } } | null>(null);
  const [details, setDetails] = useState({ name: "", courseId: "", subject: "", durationMinutes: "60", description: "", instructions: "" });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const importReady = parsed !== null && parsed.preview.issues.length === 0 && parsed.preview.summary.questions > 0;
  const set = (patch: Partial<typeof details>) => setDetails((d) => ({ ...d, ...patch }));

  function create() {
    setFormError(null);
    setRowErrors([]);
    startTransition(async () => {
      const result = method !== "manual" && parsed ? await createPaperFromImportAction(details, parsed.file) : await createPaperAction(details);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setRowErrors(result.fieldErrors?.rows ?? []);
        const fieldShown = result.fieldErrors && Object.keys(result.fieldErrors).some((k) => k in details);
        setFormError(fieldShown ? null : result.error);
        return;
      }
      const added = "questionsAdded" in result.data! ? (result.data as { questionsAdded: number }).questionsAdded : 0;
      toast.success("Question paper created", added ? `${added} questions imported and saved.` : "Draft saved. Add sections and questions next.");
      router.push(`/admin/import-questions/${result.data!.id}/edit?step=${added ? "review" : "details"}`);
    });
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Import Questions", href: "/admin/import-questions" }, { label: "Import question paper" }]}
        title="Import Question Paper"
        description="Upload a paper from the template, or create one manually. Then configure its structure, review the questions and submit it for review."
      />
      <div className="mb-6 rounded-lg border bg-card px-4 py-3">
        <Stepper steps={STEPS} current={step} maxReached={step} onStepClick={(i) => i < step && setStep(i)} />
      </div>

      {step === 0 ? (
        method === null || method === "manual" ? (
          <Panel title="Choose import method" description="Pick how your question paper is prepared.">
            <div className="grid gap-3 md:grid-cols-3">
              {IMPORT_METHODS.map((m) => (
                <div key={m.key} className="flex flex-col rounded-lg border p-4">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <m.icon className="size-5" aria-hidden />
                  </span>
                  <p className="mt-3 text-sm font-semibold">{m.key === "excel" ? "Excel template (CSV)" : m.title}</p>
                  <p className="mt-1 flex-1 text-sm text-muted-foreground">{m.key === "excel" ? "Most reliable. One row per question with sections, marks and answer keys in columns." : "Not supported yet."}</p>
                  <Button className="mt-4 self-start" size="sm" variant={m.key === "excel" ? "default" : "outline"} onClick={() => setMethod(m.key)}>
                    Select
                  </Button>
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-dashed px-4 py-3">
              <span className="text-sm text-muted-foreground">No file? Build the paper section by section instead.</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setMethod("manual");
                  setParsed(null);
                  setStep(1);
                }}
              >
                <FilePlus2 /> Create manually
              </Button>
            </div>
          </Panel>
        ) : (
          <Panel
            title={`Upload ${method === "excel" ? "the question paper template" : IMPORT_METHODS.find((m) => m.key === method)!.title}`}
            description="The file is read and validated on the server. Nothing is saved until you create the paper."
            actions={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMethod(null);
                  setParsed(null);
                }}
              >
                Change method
              </Button>
            }
          >
            <ImportUpload method={method} preview={parsed?.preview ?? null} onParsed={setParsed} />
            <div className="mt-4 flex justify-end">
              <Button disabled={!importReady} onClick={() => setStep(1)}>
                Continue to paper details
              </Button>
            </div>
          </Panel>
        )
      ) : null}

      {step === 1 ? (
        <Panel title="Question paper details" description={method === "manual" ? "Create an empty draft, then add sections and questions." : `${parsed?.preview.summary.questions ?? 0} questions from ${parsed?.preview.fileName} will be saved with this paper.`}>
          <div className="grid gap-4">
            <Field label="Question paper name" htmlFor="pname" required error={errors.name?.[0]}>
              <Input id="pname" value={details.name} onChange={(e) => set({ name: e.target.value })} placeholder="AI for Leaders — Final Exam" aria-invalid={!!errors.name || undefined} />
            </Field>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Course" htmlFor="pcourse" required error={errors.courseId?.[0]} hint={courses.length === 0 ? "Create a course first (Courses)." : undefined}>
                <SelectField id="pcourse" value={details.courseId} onChange={(v) => set({ courseId: v })} placeholder="Select a course" options={courses.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} invalid={!!errors.courseId} />
              </Field>
              <Field label="Subject" htmlFor="psub" error={errors.subject?.[0]}>
                <Input id="psub" value={details.subject} onChange={(e) => set({ subject: e.target.value })} />
              </Field>
              <Field label="Suggested duration" htmlFor="pdur" hint="Minutes" error={errors.durationMinutes?.[0]}>
                <Input id="pdur" type="number" min={1} value={details.durationMinutes} onChange={(e) => set({ durationMinutes: e.target.value })} />
              </Field>
            </div>
            <Field label="Description" htmlFor="pdesc" hint="Internal note for admins and proctors." error={errors.description?.[0]}>
              <Textarea id="pdesc" rows={2} value={details.description} onChange={(e) => set({ description: e.target.value })} />
            </Field>
            <Field label="Instructions for learners" htmlFor="pinstr" error={errors.instructions?.[0]}>
              <Textarea id="pinstr" rows={3} value={details.instructions} onChange={(e) => set({ instructions: e.target.value })} />
            </Field>
            <ImportIssues issues={rowErrors} />
            {formError ? (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            ) : null}
          </div>
          <div className="mt-4 flex justify-between gap-2">
            <Button variant="outline" onClick={() => setStep(0)} disabled={pending}>
              Back
            </Button>
            <Button onClick={create} disabled={pending}>
              {pending ? "Saving…" : method === "manual" ? "Create paper" : `Create paper & import ${parsed?.preview.summary.questions ?? 0} questions`}
            </Button>
          </div>
        </Panel>
      ) : null}
    </>
  );
}
