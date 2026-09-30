"use client";

// Supporting material that an ADMIN attaches to a question for learners to consult.
// This is deliberately separate from learner answer uploads (a later phase).
// Prototype only: nothing is uploaded, stored or downloaded; previews are mock content.

import { useRef, useState } from "react";
import { CircleCheck, Download, Eye, FileImage, FileSpreadsheet, FileText, Paperclip, Trash2, Upload } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { newId } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { MaterialKind, SupportingMaterial } from "@/prototype/types";
import { ConfirmDialog, Field, SelectField } from "./controls";
import { FileIcon, FileViewer, formatSize } from "./file-viewer";

export const MATERIAL_TYPES: Record<MaterialKind, { label: string; exts: string[]; sample: string }> = {
  image: { label: "Image", exts: ["png", "jpg", "jpeg", "svg"], sample: "Market Share.png" },
  document: { label: "Document", exts: ["pdf", "doc", "docx", "ppt", "pptx"], sample: "Market Analysis.pdf" },
  dataset: { label: "Dataset/File", exts: ["xls", "xlsx", "csv"], sample: "Sales Data.csv" },
};

const ICON: Record<MaterialKind, typeof FileText> = { image: FileImage, document: FileText, dataset: FileSpreadsheet };

function kindFor(ext: string): MaterialKind | null {
  return (Object.keys(MATERIAL_TYPES) as MaterialKind[]).find((k) => MATERIAL_TYPES[k].exts.includes(ext)) ?? null;
}

export function MaterialIcon({ kind, className }: { kind: MaterialKind; className?: string }) {
  const Icon = ICON[kind];
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground", className)}>
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

/**
 * Admin-provided supporting material.
 * Admin: Preview / Download / Remove. Learner: View / Download (both simulated, in-app).
 * Learner answer attachments are a different component (AnswerUpload) with separate state.
 */
export function MaterialList({
  materials,
  mode = "admin",
  onRemove,
  onDownload,
  className,
}: {
  materials: SupportingMaterial[];
  mode?: "admin" | "learner";
  onRemove?: (id: string) => void;
  /** Learner mode: notified when a file is "downloaded". */
  onDownload?: (m: SupportingMaterial) => void;
  className?: string;
}) {
  const toast = useToast();
  const [viewing, setViewing] = useState<SupportingMaterial | null>(null);
  const [removing, setRemoving] = useState<SupportingMaterial | null>(null);
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  if (materials.length === 0) return null;

  const download = (m: SupportingMaterial) => {
    toast.info("Download simulated in prototype mode.", m.name);
    setDownloaded((d) => new Set(d).add(m.id));
    onDownload?.(m);
  };

  return (
    <>
      <ul className={cn("divide-y rounded-lg border", className)}>
        {materials.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <FileIcon ext={m.ext} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{m.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {mode === "learner" && m.description ? m.description : `${MATERIAL_TYPES[m.kind].label} · ${m.ext.toUpperCase()} · ${formatSize(m.sizeKb)}${m.description ? ` · ${m.description}` : ""}`}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {mode === "learner" && downloaded.has(m.id) ? (
                <span className="mr-1 inline-flex items-center gap-1 text-xs text-emerald-700">
                  <CircleCheck className="size-3.5" /> Downloaded
                </span>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => setViewing(m)}>
                <Eye /> {mode === "learner" ? "View" : "Preview"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => download(m)}>
                <Download /> Download
              </Button>
              {mode === "admin" && onRemove ? (
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setRemoving(m)}>
                  <Trash2 /> Remove
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <FileViewer file={viewing} variant="material" onClose={() => setViewing(null)} allowDownload />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove supporting material?"
        description={`${removing?.name} will no longer be shown with this question.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (removing && onRemove) {
            onRemove(removing.id);
            toast.success("Supporting material removed", removing.name);
          }
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Add dialog
// ---------------------------------------------------------------------------

export function AddMaterialDialog({ open, onOpenChange, onAdd }: { open: boolean; onOpenChange: (o: boolean) => void; onAdd: (m: SupportingMaterial) => void }) {
  const [kind, setKind] = useState<MaterialKind>("document");
  const [fileName, setFileName] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const accept = MATERIAL_TYPES[kind].exts.map((e) => `.${e}`).join(",");

  const reset = () => {
    setKind("document");
    setFileName(null);
    setDescription("");
    setError(null);
  };
  const close = (o: boolean) => {
    if (!o) reset();
    onOpenChange(o);
  };

  function pick(name: string) {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const detected = kindFor(ext);
    if (!detected) {
      setError(`.${ext} files aren’t supported. Allowed: ${Object.values(MATERIAL_TYPES).flatMap((t) => t.exts).join(", ")}.`);
      setFileName(null);
      return;
    }
    if (detected !== kind) setKind(detected);
    setError(null);
    setFileName(name);
  }

  function add() {
    if (!fileName) {
      setError("Choose a file to attach.");
      return;
    }
    const ext = fileName.split(".").pop()!.toLowerCase();
    onAdd({
      id: newId("m"),
      name: fileName,
      kind,
      ext,
      sizeKb: kind === "image" ? 240 : kind === "dataset" ? 36 : 520,
      description: description.trim() || undefined,
    });
    close(false);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Supporting Material</DialogTitle>
          <DialogDescription>Learners can open it in the assessment. It is not uploaded in prototype mode.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Material type" htmlFor="mtype" hint={`Allowed: ${MATERIAL_TYPES[kind].exts.map((e) => e.toUpperCase()).join(", ")}`}>
            <SelectField
              id="mtype"
              value={kind}
              onChange={(v) => {
                setKind(v as MaterialKind);
                setFileName(null);
                setError(null);
              }}
              options={(Object.keys(MATERIAL_TYPES) as MaterialKind[]).map((k) => ({ value: k, label: MATERIAL_TYPES[k].label }))}
            />
          </Field>
          <Field label="File" error={error}>
            <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2.5">
              {fileName ? (
                <>
                  <MaterialIcon kind={kind} />
                  <span className="min-w-0 flex-1 truncate text-sm">{fileName}</span>
                  <Button variant="ghost" size="sm" onClick={() => setFileName(null)}>
                    Change
                  </Button>
                </>
              ) : (
                <>
                  <Paperclip className="size-4 text-muted-foreground" aria-hidden />
                  <span className="flex-1 text-sm text-muted-foreground">No file chosen</span>
                  <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
                    <Upload /> Choose File
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => pick(MATERIAL_TYPES[kind].sample)}>
                    Use sample
                  </Button>
                </>
              )}
              <input
                ref={inputRef}
                type="file"
                accept={accept}
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) pick(f.name); // only the name is used — nothing is read or uploaded
                  e.target.value = "";
                }}
              />
            </div>
          </Field>
          <Field label="Description" htmlFor="mdesc" hint="Optional — shown to learners next to the file.">
            <Input id="mdesc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Regional sales for Q1–Q3" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button onClick={add}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
