"use client";

// The LEARNER's answer attachment — files the learner submits as their answer.
// Deliberately separate from admin "Supporting Material": different component, different state.
// Prototype: nothing is uploaded; selection, progress and failures are simulated.

import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Eye, FolderOpen, Loader2, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { acceptLabel } from "@/prototype/lib/response";
import { newId } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { AnswerAttachment, ResponseConfig } from "@/prototype/types";
import { ConfirmDialog } from "./controls";
import { FileIcon, FileViewer, formatSize } from "./file-viewer";

interface MockFile {
  name: string;
  sizeKb: number;
  modified: string;
}

/** What the learner's "computer" contains in the mock file picker. */
const MOCK_FILES: MockFile[] = [
  { name: "sales-data-completed.csv", sizeKb: 245, modified: "Today, 10:42 AM" },
  { name: "sales-data-final.csv", sizeKb: 251, modified: "Today, 10:51 AM" },
  { name: "sales-analysis.xlsx", sizeKb: 312, modified: "Today, 10:48 AM" },
  { name: "sales-recommendation.pdf", sizeKb: 188, modified: "Today, 11:02 AM" },
  { name: "sales-recommendation.docx", sizeKb: 96, modified: "Today, 10:58 AM" },
  { name: "sales-deck.pptx", sizeKb: 1434, modified: "Yesterday" },
  { name: "full-sales-export.csv", sizeKb: 34816, modified: "Yesterday" },
  { name: "sales-data-completed.zip", sizeKb: 240, modified: "Today, 10:44 AM" },
];

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; file: MockFile; progress: number; replacing?: string }
  | { kind: "failed"; file: MockFile; reason: string };

export function AnswerUpload({
  config,
  attachments,
  onChange,
  questionLabel,
  heading = "Your Answer",
  helper = "Upload your completed file below.",
  onPreview,
}: {
  config: ResponseConfig;
  attachments: AnswerAttachment[];
  onChange: (next: AnswerAttachment[]) => void;
  /** e.g. "Question 7" */
  questionLabel: string;
  heading?: string;
  helper?: string;
  onPreview?: () => void;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [picking, setPicking] = useState<null | { replacing?: string }>(null);
  const [previewing, setPreviewing] = useState<AnswerAttachment | null>(null);
  const [removing, setRemoving] = useState<AnswerAttachment | null>(null);
  const [justUploaded, setJustUploaded] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingReplace = useRef<string | undefined>(undefined);

  // Keep "Uploaded just now / 2 min ago" fresh, and stop timers on unmount.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000);
    return () => {
      clearInterval(t);
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const accept = acceptLabel(config.allowedTypes);
  const canAddMore = attachments.length < config.maxFiles;

  function start(file: MockFile, replacing?: string) {
    const ext = extOf(file.name);
    if (!config.allowedTypes.includes(ext)) {
      setPhase({ kind: "failed", file, reason: `${ext.toUpperCase() || "This"} files aren’t accepted for this question. Accepted: ${accept}.` });
      return;
    }
    const tooLarge = file.sizeKb > config.maxSizeMb * 1024;
    setPhase({ kind: "uploading", file, progress: 5, replacing });
    let p = 5;
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      p += tooLarge ? 12 : 19;
      if (tooLarge && p >= 60) {
        clearInterval(timer.current!);
        setPhase({ kind: "failed", file, reason: `File is ${formatSize(file.sizeKb)} — the maximum size is ${config.maxSizeMb} MB.` });
        return;
      }
      if (p >= 100) {
        clearInterval(timer.current!);
        const att: AnswerAttachment = { id: newId("att"), name: file.name, ext, sizeKb: file.sizeKb, uploadedAt: new Date().toISOString() };
        onChange(replacing ? attachments.map((a) => (a.id === replacing ? att : a)) : [...attachments, att]);
        setPhase({ kind: "idle" });
        setJustUploaded(att.id);
        setTimeout(() => setJustUploaded((id) => (id === att.id ? null : id)), 2500);
        toast.success(replacing ? "File replaced" : "Uploaded successfully", `${file.name} is attached to ${questionLabel}.`);
        return;
      }
      setPhase({ kind: "uploading", file, progress: p, replacing });
    }, 180);
  }

  function fromBrowserFile(f: File, replacing?: string) {
    // Only the name and size are used — the file is never read or sent anywhere.
    start({ name: f.name, sizeKb: Math.max(1, Math.round(f.size / 1024)), modified: "Just now" }, replacing);
  }

  const uploading = phase.kind === "uploading" ? phase : null;

  return (
    <section aria-label={heading} className="grid gap-3">
      <div>
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{heading}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{helper}</p>
      </div>

      {attachments.length ? (
        <ul className="grid gap-2">
          {attachments.map((a) => {
            const isReplacing = uploading?.replacing === a.id;
            return (
              <li key={a.id} className={cn("rounded-lg border px-4 py-3", justUploaded === a.id && "border-emerald-300 bg-emerald-50/50")}>
                <div className="flex flex-wrap items-start gap-3">
                  <FileIcon ext={a.ext} tone="answer" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{a.name}</p>
                    <p className="text-xs text-muted-foreground">{uploadedAgo(a.uploadedAt)}</p>
                    <p className="mt-1 flex items-center gap-1 text-xs font-medium text-emerald-700">
                      <CircleCheck className="size-3.5" /> {justUploaded === a.id ? "Uploaded successfully · " : ""}Attached to {questionLabel}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setPreviewing(a);
                        onPreview?.();
                      }}
                      disabled={isReplacing}
                    >
                      <Eye /> Preview
                    </Button>
                    {config.allowReplace ? (
                      <Button variant="ghost" size="sm" onClick={() => setPicking({ replacing: a.id })} disabled={!!uploading}>
                        <RefreshCw /> Replace
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setRemoving(a)} disabled={!!uploading}>
                      <Trash2 /> Remove
                    </Button>
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-3 border-t pt-2.5 text-xs">
                  <div>
                    <dt className="text-muted-foreground">File type</dt>
                    <dd className="font-medium">{a.ext.toUpperCase()}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">File size</dt>
                    <dd className="font-medium tabular-nums">{formatSize(a.sizeKb)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Upload status</dt>
                    <dd className="font-medium">{isReplacing ? "Replacing…" : "Uploaded"}</dd>
                  </div>
                </dl>
                {isReplacing && uploading ? <UploadProgress name={uploading.file.name} progress={uploading.progress} replacing /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {uploading && !uploading.replacing ? (
        <div className="rounded-lg border px-4 py-3">
          <UploadProgress name={uploading.file.name} progress={uploading.progress} />
        </div>
      ) : null}

      {phase.kind === "failed" ? (
        <div className="flex flex-wrap items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3" role="alert">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-red-900">Upload failed — {phase.file.name}</p>
            <p className="text-xs text-red-900/80">{phase.reason}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setPicking({})}>
            Choose another file
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setPhase({ kind: "idle" })}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {canAddMore && !uploading ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) fromBrowserFile(f);
          }}
          className={cn(
            "flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 text-center transition-colors",
            attachments.length ? "py-4" : "py-8",
            dragOver ? "border-primary bg-accent/50" : "border-border",
          )}
        >
          <UploadCloud className="size-6 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-sm font-medium">{attachments.length ? "Add another file" : "Drag & drop your completed file"}</p>
          <p className="text-xs text-muted-foreground">or</p>
          <Button className="mt-2" size="sm" onClick={() => setPicking({})}>
            <FolderOpen /> {attachments.length ? "Choose File" : "Upload Answer"}
          </Button>
          <p className="mt-3 text-xs text-muted-foreground">
            Accepted: <span className="font-medium text-foreground">{accept}</span> · Maximum size: <span className="font-medium text-foreground">{config.maxSizeMb} MB</span>
            {config.maxFiles > 1 ? ` · Up to ${config.maxFiles} files` : ""}
          </p>
        </div>
      ) : null}

      {/* Real input is only used to read a file NAME when the learner browses their computer. */}
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        accept={config.allowedTypes.map((e) => `.${e}`).join(",")}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) fromBrowserFile(f, pendingReplace.current);
          e.target.value = "";
        }}
      />

      {/* Mock file picker ("Selecting file" state) */}
      <Dialog open={picking !== null} onOpenChange={(o) => !o && setPicking(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{picking?.replacing ? "Replace file" : "Select your completed file"}</DialogTitle>
            <DialogDescription>
              Prototype file picker — choose one of these sample files. Accepted for {questionLabel}: {accept} · max {config.maxSizeMb} MB.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-80 divide-y overflow-auto rounded-lg border">
            {MOCK_FILES.map((f) => {
              const ext = extOf(f.name);
              const accepted = config.allowedTypes.includes(ext);
              const tooLarge = f.sizeKb > config.maxSizeMb * 1024;
              return (
                <li key={f.name}>
                  <button
                    type="button"
                    onClick={() => {
                      const replacing = picking?.replacing;
                      setPicking(null);
                      start(f, replacing);
                    }}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted"
                  >
                    <FileIcon ext={ext} className="size-8" />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-sm", accepted ? "font-medium" : "text-muted-foreground")}>{f.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatSize(f.sizeKb)} · {f.modified}
                      </span>
                    </span>
                    {!accepted ? <span className="text-[11px] text-muted-foreground">Type not accepted</span> : tooLarge ? <span className="text-[11px] text-amber-700">Over size limit</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                pendingReplace.current = picking?.replacing;
                setPicking(null);
                inputRef.current?.click();
              }}
            >
              Browse this computer…
            </Button>
            <Button variant="outline" onClick={() => setPicking(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FileViewer file={previewing} variant="answer" context={questionLabel} onClose={() => setPreviewing(null)} allowDownload={false} />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove submitted file?"
        description="Your uploaded file will be removed from this question."
        confirmLabel="Remove File"
        destructive
        onConfirm={() => {
          if (!removing) return;
          onChange(attachments.filter((a) => a.id !== removing.id));
          toast.success("File removed", `${removing.name} was removed from ${questionLabel}. The supporting material is unchanged.`);
        }}
      />
    </section>
  );
}

function UploadProgress({ name, progress, replacing }: { name: string; progress: number; replacing?: boolean }) {
  return (
    <div className="mt-2 grid gap-1.5" aria-live="polite">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          <span className="truncate">
            {replacing ? "Replacing with " : "Uploading "}
            <span className="font-medium">{name}</span>…
          </span>
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{Math.min(100, progress)}%</span>
      </div>
      <Progress value={Math.min(100, progress)} />
    </div>
  );
}

function uploadedAgo(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "Uploaded just now";
  return `Uploaded ${mins} min ago`;
}

/** Subtle indicator of the resource → answer workflow for file questions. */
export function FileWorkflowSteps({ downloaded, uploaded, previewed }: { downloaded: boolean; uploaded: boolean; previewed: boolean }) {
  const steps = [
    { label: "Download resource", done: downloaded },
    { label: "Work on the file", done: downloaded && uploaded },
    { label: "Upload completed file", done: uploaded },
    { label: "Preview", done: previewed },
    { label: "Submit", done: false },
  ];
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground" aria-label="File answer workflow">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center gap-1.5">
          <span className={cn("flex items-center gap-1", s.done && "text-emerald-700", i === current && "font-medium text-foreground")}>
            {s.done ? <CircleCheck className="size-3" aria-hidden /> : <span className="size-1.5 rounded-full bg-current" aria-hidden />}
            {s.label}
          </span>
          {i < steps.length - 1 ? <span aria-hidden>→</span> : null}
        </li>
      ))}
    </ol>
  );
}
