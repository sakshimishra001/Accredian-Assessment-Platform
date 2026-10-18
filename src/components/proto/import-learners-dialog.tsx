"use client";

import { useRef, useState, useTransition } from "react";
import { AlertTriangle, FileSpreadsheet, Upload, UserPlus, X } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { parseLearnerCsv, type LearnerCsvRow } from "@/lib/academic/learner-csv";
import { useToast } from "@/prototype/toast";
import { addLearnerAction, importLearnersAction } from "@/server/actions/academic";
import { Field } from "./controls";

export interface PickedCsv {
  fileName: string;
  content: string;
  rows: LearnerCsvRow[];
}

/** File picker for a learner CSV (name,email). Reads the file in the browser; the server re-validates it. */
export function LearnerCsvPicker({ value, onChange, error }: { value: PickedCsv | null; onChange: (v: PickedCsv | null) => void; error?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [readError, setReadError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    const content = await file.text();
    const { rows, error: e } = parseLearnerCsv(content);
    setReadError(e);
    onChange(e ? null : { fileName: file.name, content, rows });
    if (input.current) input.current.value = "";
  }

  return (
    <div className="grid gap-2">
      <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label="Learner CSV file" onChange={(e) => pick(e.target.files?.[0])} />
      {value ? (
        <div className="rounded-lg border">
          <div className="flex items-center gap-3 px-3 py-2.5">
            <FileSpreadsheet className="size-5 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{value.fileName}</p>
              <p className="text-xs text-muted-foreground">{value.rows.length} learner row{value.rows.length === 1 ? "" : "s"} found</p>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Remove file" onClick={() => onChange(null)}>
              <X />
            </Button>
          </div>
          <ul className="border-t px-3 py-2 text-xs text-muted-foreground">
            {value.rows.slice(0, 3).map((r) => (
              <li key={r.row} className="truncate">
                {r.name || "—"} · <span className="font-mono">{r.email || "—"}</span>
              </li>
            ))}
            {value.rows.length > 3 ? <li>…and {value.rows.length - 3} more</li> : null}
          </ul>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-3 py-3">
          <FileSpreadsheet className="size-5 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">
            Required columns: <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">name,email</code>
          </div>
          <Button variant="outline" size="sm" onClick={() => input.current?.click()}>
            <Upload /> Choose CSV
          </Button>
        </div>
      )}
      {readError || error ? <p className="text-sm text-destructive">{readError || error}</p> : null}
    </div>
  );
}

/** Server-side row problems (one message per row), shown as a short list. */
export function RowErrors({ messages }: { messages: string[] | undefined }) {
  if (!messages?.length) return null;
  return (
    <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset" role="alert">
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4" /> Nothing was imported. Fix these rows and try again:
      </p>
      <ul className="mt-1 max-h-40 list-disc overflow-auto pl-6 text-xs">
        {messages.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Add learners to a batch — one at a time or from a CSV. No password is set here: an administrator
 * issues each learner one password (Assessment → Learners), used for all their assessments.
 */
export function ImportLearnersDialog({
  open,
  onOpenChange,
  batchId,
  batchName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  batchId: string;
  batchName: string;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<"csv" | "single">("single");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [csv, setCsv] = useState<PickedCsv | null>(null);
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Reset the form whenever the dialog closes, so it opens fresh next time.
  const handleOpenChange = (o: boolean) => {
    if (pending) return;
    if (!o) {
      setName("");
      setEmail("");
      setCsv(null);
      setErrors({});
      setFormError(null);
    }
    onOpenChange(o);
  };

  function addSingle() {
    const e: Record<string, string[]> = {};
    if (name.trim().length < 2) e.name = ["Enter the learner’s name."];
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) e.email = ["Enter a valid email address."];
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) return;
    startTransition(async () => {
      const result = await addLearnerAction({ name, email, batchId });
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setFormError(result.fieldErrors?.name || result.fieldErrors?.email ? null : result.error);
        return;
      }
      toast.success(`${result.data!.name} added to ${batchName}`, result.data!.created ? "New learner account created." : "Existing learner account reused.");
      handleOpenChange(false);
    });
  }

  function importCsv() {
    if (!csv) return setErrors({ csv: ["Choose a CSV file."] });
    setErrors({});
    setFormError(null);
    startTransition(async () => {
      const result = await importLearnersAction(batchId, { fileName: csv.fileName, content: csv.content });
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setFormError(result.fieldErrors?.rows ? null : result.error);
        return;
      }
      const s = result.data!;
      toast.success(`${s.created + s.addedExisting} learner${s.created + s.addedExisting === 1 ? "" : "s"} added to ${batchName}`, `${s.created} new · ${s.addedExisting} existing · ${s.alreadyInBatch} already in the batch`);
      handleOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add learners · {batchName}</DialogTitle>
          <DialogDescription>Learners are identified by email. Each learner gets one password for all their assessments, issued from the assessment’s Learners tab.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist">
          {(
            [
              ["single", "Add one learner"],
              ["csv", "Upload CSV"],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={mode === k}
              onClick={() => {
                setMode(k);
                setErrors({});
                setFormError(null);
              }}
              className={cn("flex-1 rounded-md px-2 py-1 text-sm", mode === k ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}
            >
              {l}
            </button>
          ))}
        </div>

        {mode === "csv" ? (
          <div className="grid gap-3">
            <LearnerCsvPicker value={csv} onChange={setCsv} error={errors.csv?.[0]} />
            <RowErrors messages={errors.rows} />
          </div>
        ) : (
          <div className="grid gap-3">
            <Field label="Full name" htmlFor="ln" error={errors.name?.[0]}>
              <Input id="ln" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name || undefined} />
            </Field>
            <Field label="Email" htmlFor="le" error={errors.email?.[0]}>
              <Input id="le" type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!errors.email || undefined} />
            </Field>
          </div>
        )}
        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          {mode === "csv" ? (
            <Button disabled={!csv || pending} onClick={importCsv}>
              {pending ? "Importing…" : `Import ${csv ? `${csv.rows.length} ` : ""}learners`}
            </Button>
          ) : (
            <Button onClick={addSingle} disabled={pending}>
              <UserPlus /> {pending ? "Adding…" : "Add learner"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
