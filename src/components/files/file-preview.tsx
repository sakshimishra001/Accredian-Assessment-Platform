"use client";

import { useEffect, useState } from "react";
import { Download, Eye, FileImage, FileSpreadsheet, FileText, Presentation } from "lucide-react";
import { cn } from "cn";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FILE_TYPES, fileUrl, formatBytes } from "@/lib/files/types";
import { expectNativeDialog } from "@/lib/proctoring/expected-interactions";

/** A download may open the browser's save dialog or downloads panel: announced so exam proctoring doesn't count it as leaving. */
const announceDownload = () => void expectNativeDialog("download");

export interface FileMeta {
  id: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
}

const ICON = { image: FileImage, document: FileText, spreadsheet: FileSpreadsheet, presentation: Presentation, code: FileText } as const;

/** Send a file to one of the upload routes; resolves to the route's JSON (ok / error / fieldErrors). */
export async function uploadFile<T>(url: string, fields: Record<string, string | undefined>, file: File): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v) form.set(k, v);
  form.set("file", file);
  try {
    const res = await fetch(url, { method: "POST", body: form });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.ok) return { ok: true, data: body.data as T };
    if (res.status === 401) return { ok: false, error: "Your session has ended. Please sign in again." };
    return { ok: false, error: body?.error ?? `Upload failed (${res.status}).` };
  } catch {
    return { ok: false, error: "No connection — the file wasn’t uploaded. Try again." };
  }
}

/** A stored file with Preview (where the app can show it) and Download. */
export function FileChip({ file, description, actions, className }: { file: FileMeta; description?: string | null; actions?: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const info = FILE_TYPES[file.extension];
  const Icon = ICON[info?.family ?? "document"];
  return (
    <div className={cn("flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm", className)}>
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{file.fileName}</span>
        <span className="block text-xs text-muted-foreground">
          {file.extension.toUpperCase()} · {formatBytes(file.sizeBytes)}
          {description ? ` · ${description}` : ""}
        </span>
      </span>
      {info?.preview ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`Preview ${file.fileName}`}>
          <Eye /> Preview
        </Button>
      ) : null}
      <a href={fileUrl(file.id)} className={buttonVariants({ variant: "ghost", size: "sm" })} aria-label={`Download ${file.fileName}`} download onClick={announceDownload}>
        <Download /> Download
      </a>
      {actions}
      {open ? <FilePreviewDialog file={file} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function parseCsv(text: string, maxRows = 200): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** In-app preview: images and PDFs inline, CSV as a table, text as text. Nothing is converted. */
export function FilePreviewDialog({ file, onClose }: { file: FileMeta; onClose: () => void }) {
  const preview = FILE_TYPES[file.extension]?.preview ?? null;
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (preview !== "csv" && preview !== "text") return;
    let cancelled = false;
    fetch(fileUrl(file.id, { inline: true }))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => !cancelled && setText(t))
      .catch(() => !cancelled && setError("This file couldn’t be loaded."));
    return () => {
      cancelled = true;
    };
  }, [file.id, preview]);

  const rows = preview === "csv" && text !== null ? parseCsv(text) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{file.fileName}</DialogTitle>
          <DialogDescription>
            {file.extension.toUpperCase()} · {formatBytes(file.sizeBytes)} ·{" "}
            <a href={fileUrl(file.id)} className="text-primary underline" download onClick={announceDownload}>
              Download
            </a>
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-auto rounded-lg border bg-muted/30">
          {preview === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element -- authorised, uncached file route
            <img src={fileUrl(file.id, { inline: true })} alt={file.fileName} className="mx-auto max-h-[68vh] object-contain" />
          ) : preview === "pdf" ? (
            <iframe src={fileUrl(file.id, { inline: true })} title={file.fileName} className="h-[68vh] w-full bg-white" />
          ) : error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : text === null ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : rows ? (
            <table className="w-full text-xs">
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={cn("border-b", i === 0 && "bg-muted font-medium")}>
                    {r.map((c, j) => (
                      <td key={j} className="px-2 py-1 whitespace-nowrap">
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <pre className="p-4 text-xs whitespace-pre-wrap">{text}</pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
