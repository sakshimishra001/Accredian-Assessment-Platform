"use client";

import { useRef, useState } from "react";
import { Paperclip, RefreshCw, Trash2, Upload } from "lucide-react";
import { FileChip, uploadFile, type FileMeta } from "@/components/files/file-preview";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/files/types";
import { expectNativeDialog } from "@/lib/proctoring/expected-interactions";
import { removeAnswerFileAction } from "@/server/actions/attempts";
import type { ExamMaterial, ExamResponseConfig } from "@/server/services/attempts";

export interface AnswerFile {
  id: string;
  file: FileMeta;
}

/** Admin-provided files shown with a question (and its case/passage). */
export function QuestionMaterials({ materials }: { materials: ExamMaterial[] }) {
  if (materials.length === 0) return null;
  return (
    <section aria-label="Supporting material" className="grid gap-1.5 rounded-lg bg-muted/40 p-3">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Supporting material</p>
      {materials.map((m) => (
        <FileChip key={m.fileId} file={{ id: m.fileId, fileName: m.fileName, extension: m.extension, sizeBytes: m.sizeBytes }} description={m.description} />
      ))}
    </section>
  );
}

/**
 * The learner's uploaded files for one question: upload, preview, replace, remove. The server
 * validates type/size/count and that the attempt is the learner's own and still open.
 */
export function AnswerFiles({
  attemptId,
  assessmentQuestionId,
  questionLabel,
  config,
  files,
  onChange,
  onClosed,
}: {
  attemptId: string;
  assessmentQuestionId: string;
  questionLabel: string;
  config: ExamResponseConfig;
  files: AnswerFile[];
  onChange: (files: AnswerFile[]) => void;
  /** The attempt was closed on the server (submitted / time up). */
  onClosed: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accept = config.allowedFileTypes.map((e) => `.${e}`).join(",");
  const full = files.length >= config.maxFiles;

  async function send(file: File) {
    setError(null);
    if (file.size > config.maxFileSizeMb * 1024 * 1024) return setError(`The file is too large (${formatBytes(file.size)}). The limit is ${config.maxFileSizeMb} MB.`);
    setBusy(replacing ? "Replacing…" : "Uploading…");
    const r = await uploadFile<{ attachmentId: string; file: FileMeta }>(`/api/attempts/${attemptId}/files`, { assessmentQuestionId, replaceAttachmentId: replacing ?? undefined }, file);
    setBusy(null);
    if (!r.ok) {
      if (/already been submitted|Time is up/.test(r.error)) return onClosed(r.error);
      return setError(r.error);
    }
    const added = { id: r.data.attachmentId, file: r.data.file };
    onChange(replacing ? files.map((f) => (f.id === replacing ? added : f)) : [...files, added]);
    setReplacing(null);
  }

  async function remove(id: string) {
    setError(null);
    setBusy("Removing…");
    const r = await removeAnswerFileAction(attemptId, id).catch(() => ({ ok: false as const, error: "No connection — try again." }));
    setBusy(null);
    if (!r.ok) {
      if (/already been submitted|Time is up/.test(r.error)) return onClosed(r.error);
      return setError(r.error);
    }
    onChange(files.filter((f) => f.id !== id));
  }

  const pick = (replaceId: string | null) => {
    setReplacing(replaceId);
    // The system file picker takes focus from the page (and Chromium leaves fullscreen to show it):
    // announce it so proctoring doesn't count it as leaving the exam.
    expectNativeDialog("file-picker");
    input.current?.click();
  };

  return (
    <div className="grid gap-2">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {config.type === "FILE" ? "Your answer" : "Answer attachment"} · {config.fileRequired ? "required" : "optional"}
      </p>
      <input
        ref={input}
        type="file"
        className="sr-only"
        accept={accept}
        aria-label={`File for ${questionLabel}`}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void send(f);
        }}
      />
      {files.map((f) => (
        <FileChip
          key={f.id}
          file={f.file}
          actions={
            <>
              <Button type="button" variant="ghost" size="sm" onClick={() => pick(f.id)} disabled={!!busy} aria-label={`Replace ${f.file.fileName}`}>
                <RefreshCw /> Replace
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => void remove(f.id)} disabled={!!busy} aria-label={`Remove ${f.file.fileName}`}>
                <Trash2 />
              </Button>
            </>
          }
        />
      ))}
      {!full ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3">
          <Button type="button" variant="outline" onClick={() => pick(null)} disabled={!!busy}>
            {files.length ? <Paperclip /> : <Upload />} {files.length ? "Add another file" : "Upload file"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {config.allowedFileTypes.map((e) => `.${e}`).join(", ")} · up to {config.maxFileSizeMb} MB{config.maxFiles > 1 ? ` · up to ${config.maxFiles} files` : ""}
          </span>
        </div>
      ) : null}
      {busy ? <p className="text-xs text-muted-foreground" aria-live="polite">{busy}</p> : null}
      {error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-900 ring-1 ring-red-200 ring-inset">
          {error}
        </p>
      ) : null}
    </div>
  );
}
