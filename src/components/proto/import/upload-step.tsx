"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FilePlus2, Loader2, Sparkles, Upload } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { simulatedImportPaper } from "@/prototype/data/papers";
import { paperTotals } from "@/prototype/lib/paper";
import { newId } from "@/prototype/store";
import type { ImportSource, QuestionPaper } from "@/prototype/types";
import { IMPORT_METHODS, type ImportMethodKey } from "../import-methods";
import { Panel, PrototypeNote } from "../page";

const SAMPLE_FILE: Record<ImportMethodKey, string> = {
  excel: "Product Management Mid-Term.xlsx",
  word: "Product Management Mid-Term.docx",
  pdf: "PM-01 Mid Term 1 Question Paper.pdf",
};
const SOURCE: Record<ImportMethodKey, ImportSource> = { excel: "Excel", word: "Word", pdf: "PDF" };

const STAGES: Record<ImportMethodKey, string[]> = {
  excel: ["Uploading…", "Parsing…", "Complete"],
  word: ["Uploading…", "Parsing…", "Complete"],
  pdf: ["Uploading PDF", "Analyzing document", "Detecting questions", "Detecting sections", "Detecting options", "Detecting marks"],
};

export function UploadStep({
  method,
  onMethod,
  paper,
  onImported,
  onContinue,
  onReview,
  onManual,
}: {
  method: ImportMethodKey | null;
  onMethod: (m: ImportMethodKey | null) => void;
  paper: QuestionPaper | null;
  onImported: (p: QuestionPaper) => void;
  onContinue: () => void;
  onReview: () => void;
  onManual: () => void;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [stage, setStage] = useState(-1); // -1 idle; 0..n-1 running; n done
  const [progress, setProgress] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const stages = method ? STAGES[method] : [];
  const running = stage >= 0 && stage < stages.length;
  const done = paper !== null && stage >= stages.length;

  function start(name: string) {
    if (!method) return;
    setFileName(name);
    setStage(0);
    setProgress(4);
    const perStage = method === "pdf" ? 850 : 900;
    stages.forEach((_, i) => {
      timers.current.push(
        setTimeout(() => {
          setStage(i);
          setProgress(Math.round(((i + 1) / stages.length) * 100));
        }, i * perStage),
      );
    });
    timers.current.push(
      setTimeout(() => {
        setStage(stages.length);
        onImported(simulatedImportPaper(newId("p"), name, SOURCE[method]));
      }, stages.length * perStage + 300),
    );
  }

  function cancel() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setStage(-1);
    setProgress(0);
    setFileName(null);
  }

  if (!method) {
    return (
      <Panel title="Choose import method" description="Pick how your question paper is prepared. You can review and correct everything after import.">
        <div className="grid gap-3 md:grid-cols-3">
          {IMPORT_METHODS.map((m) => (
            <div key={m.key} className="flex flex-col rounded-lg border p-4">
              <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <m.icon className="size-5" aria-hidden />
              </span>
              <p className="mt-3 text-sm font-semibold">{m.title}</p>
              <p className="mt-1 flex-1 text-sm text-muted-foreground">{m.body}</p>
              <Button className="mt-4 self-start" size="sm" onClick={() => onMethod(m.key)}>
                Select
              </Button>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-dashed px-4 py-3">
          <span className="text-sm text-muted-foreground">No file? Build the paper section by section instead.</span>
          <Button variant="outline" size="sm" onClick={onManual}>
            <FilePlus2 /> Create manually
          </Button>
        </div>
      </Panel>
    );
  }

  const meta = IMPORT_METHODS.find((m) => m.key === method)!;
  const totals = paper ? paperTotals(paper) : null;

  return (
    <Panel
      title={method === "pdf" ? "AI-assisted question extraction" : `Upload ${meta.title}`}
      description={method === "pdf" ? "We read the PDF and detect questions, sections, options and marks. You review anything we’re unsure about." : "We map rows and headings to sections, questions, options and marks."}
      actions={
        !running && !done ? (
          <Button variant="ghost" size="sm" onClick={() => onMethod(null)}>
            Change method
          </Button>
        ) : null
      }
    >
      {!running && !done ? (
        <div className="grid gap-4">
          <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              {method === "pdf" ? <Sparkles className="size-6" /> : <Upload className="size-6" />}
            </span>
            <p className="mt-3 text-sm font-medium">Drop your {meta.accept} file here, or choose one</p>
            <p className="mt-1 text-xs text-muted-foreground">Up to 25 MB · the file is not actually read in this prototype</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button onClick={() => inputRef.current?.click()}>
                <Upload /> Choose file
              </Button>
              <Button variant="outline" onClick={() => start(SAMPLE_FILE[method])}>
                Use sample: {SAMPLE_FILE[method]}
              </Button>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept={meta.accept}
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) start(f.name);
                e.target.value = "";
              }}
            />
          </div>
          <PrototypeNote>Prototype only — upload, parsing and extraction are simulated. The sample paper is loaded regardless of the file chosen.</PrototypeNote>
        </div>
      ) : null}

      {running ? (
        <div className="grid gap-4" aria-live="polite">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{fileName}</span>
            <span className="text-sm tabular-nums text-muted-foreground">{progress}%</span>
          </div>
          <Progress value={progress} />
          <ol className="grid gap-2">
            {stages.map((label, i) => (
              <li key={label} className="flex items-center gap-2 text-sm">
                {i < stage ? (
                  <CheckCircle2 className="size-4 text-emerald-600" aria-label="Done" />
                ) : i === stage ? (
                  <Loader2 className="size-4 animate-spin text-primary" aria-label="In progress" />
                ) : (
                  <span className="size-4 rounded-full border" aria-hidden />
                )}
                <span className={cn(i > stage && "text-muted-foreground")}>{label}</span>
              </li>
            ))}
          </ol>
          <div>
            <Button variant="ghost" size="sm" onClick={cancel}>
              Cancel upload
            </Button>
          </div>
        </div>
      ) : null}

      {done && totals ? (
        <div className="grid gap-4">
          <div className="flex items-start gap-3 rounded-lg bg-emerald-50 px-4 py-3 ring-1 ring-emerald-200 ring-inset">
            <CheckCircle2 className="mt-0.5 size-5 text-emerald-600" />
            <div>
              <p className="text-sm font-semibold text-emerald-900">{totals.questions} questions detected</p>
              <p className="text-sm text-emerald-900/80">{fileName ?? paper?.fileName} · saved to the library as “Needs Review”</p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              [totals.objective, "Objective"],
              [totals.subjective, "Subjective"],
              [totals.sections, "Sections"],
              [totals.marks, "Marks detected"],
            ].map(([v, l]) => (
              <div key={String(l)} className="rounded-lg border px-3 py-2">
                <dt className="text-xs text-muted-foreground">{l}</dt>
                <dd className="text-lg font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {totals.needsReview ? (
            <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
              <AlertTriangle className="size-4" /> {totals.needsReview} questions require review before the paper can be approved.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={onContinue}>Continue to paper details</Button>
            <Button variant="outline" onClick={onReview}>
              Review Questions
            </Button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
