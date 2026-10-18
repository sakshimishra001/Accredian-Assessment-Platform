"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Paperclip, Trash2, Upload } from "lucide-react";
import { FileChip, uploadFile } from "@/components/files/file-preview";
import { ConfirmDialog, Field } from "@/components/proto/controls";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MATERIAL_EXTENSIONS, MATERIAL_KINDS, MAX_MATERIAL_MB } from "@/lib/files/types";
import { useToast } from "@/prototype/toast";
import { removeMaterialAction } from "@/server/actions/question-papers";
import type { PaperMaterial } from "@/server/services/question-papers";

/**
 * Supporting materials of one question (or case/passage) in a draft paper: list with preview /
 * download, upload (validated and stored by the server), remove.
 */
export function MaterialsEditor({ paperId, itemId, label, materials }: { paperId: string; itemId: string; label: string; materials: PaperMaterial[] }) {
  const router = useRouter();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PaperMaterial | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="mt-2 grid gap-1.5">
      {materials.map((m) => (
        <FileChip
          key={m.id}
          file={m.file}
          description={m.description}
          className="py-1.5"
          actions={
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${m.file.fileName}`} onClick={() => setRemoving(m)} disabled={pending}>
              <Trash2 />
            </Button>
          }
        />
      ))}
      <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={() => setAdding(true)} aria-label={`Add supporting material to ${label}`}>
        <Paperclip /> Add supporting material
      </Button>
      {adding ? (
        <AddMaterialDialog
          itemId={itemId}
          label={label}
          onClose={(added) => {
            setAdding(false);
            if (added) {
              toast.success("Material added", added);
              router.refresh();
            }
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.file.fileName}?`}
        description="Learners will no longer see this file with the question."
        confirmLabel="Remove"
        destructive
        onConfirm={() =>
          removing &&
          startTransition(async () => {
            const r = await removeMaterialAction(paperId, removing.id);
            if (!r.ok) return toast.error("Couldn’t remove the material", r.error);
            toast.success("Material removed");
            router.refresh();
          })
        }
      />
    </div>
  );
}

function AddMaterialDialog({ itemId, label, onClose }: { itemId: string; label: string; onClose: (added?: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save() {
    if (!file) return setError("Choose a file.");
    setPending(true);
    const r = await uploadFile("/api/files/materials", { paperQuestionId: itemId, description }, file);
    setPending(false);
    if (!r.ok) return setError(r.error);
    onClose(file.name);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add supporting material to {label}</DialogTitle>
          <DialogDescription>
            {Object.values(MATERIAL_KINDS)
              .map((k) => `${k.label}: ${k.exts.join(", ")}`)
              .join(" · ")}{" "}
            · up to {MAX_MATERIAL_MB} MB. Learners can open it during the assessment.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <input
            ref={input}
            type="file"
            className="sr-only"
            accept={MATERIAL_EXTENSIONS.map((e) => `.${e}`).join(",")}
            aria-label="Material file"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError(null);
            }}
          />
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-4">
            <Button type="button" variant="outline" onClick={() => input.current?.click()}>
              <Upload /> Choose file
            </Button>
            <span className="text-sm text-muted-foreground">{file ? file.name : "No file chosen"}</span>
          </div>
          <Field label="Description (optional)" htmlFor="mat-desc">
            <Input id="mat-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Sales data for Q3" />
          </Field>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose()} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending || !file}>
            {pending ? "Uploading…" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
