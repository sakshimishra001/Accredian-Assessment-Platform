"use client";

import { cn } from "cn";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { DEFAULT_FILE_TYPES, LEARNER_FILE_GROUPS, RESPONSE_TYPE_LABEL, TEXT_RESPONSE, acceptLabel, acceptsFiles } from "@/prototype/lib/response";
import type { ResponseConfig, ResponseType } from "@/prototype/types";
import { Field } from "./controls";

const TYPE_HELP: Record<ResponseType, string> = {
  text: "Learner types their answer.",
  file: "Learner uploads a completed file as the answer.",
  text_file: "Learner writes an answer and attaches a document.",
};

/** Admin configuration of how learners answer a subjective question (mock). */
export function ResponseConfigEditor({ value, onChange }: { value: ResponseConfig | undefined; onChange: (v: ResponseConfig) => void }) {
  const r = value ?? TEXT_RESPONSE;
  const set = (patch: Partial<ResponseConfig>) => onChange({ ...r, ...patch });
  const toggleExt = (ext: string, on: boolean) => set({ allowedTypes: on ? [...r.allowedTypes, ext] : r.allowedTypes.filter((e) => e !== ext) });

  return (
    <section className="rounded-lg border" aria-label="Learner Response">
      <div className="border-b px-3 py-2">
        <p className="text-sm font-medium">Learner Response</p>
        <p className="text-xs text-muted-foreground">How learners answer this question. Separate from the supporting material you attach.</p>
      </div>
      <div className="grid gap-4 p-3">
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Response type">
          {(Object.keys(RESPONSE_TYPE_LABEL) as ResponseType[]).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={r.type === t}
              onClick={() => set({ type: t, fileRequired: t === "file" ? true : r.fileRequired, allowedTypes: r.allowedTypes.length ? r.allowedTypes : DEFAULT_FILE_TYPES })}
              className={cn("rounded-md border px-3 py-2 text-left transition-colors", r.type === t ? "border-primary bg-accent/60 ring-1 ring-primary" : "hover:bg-muted/60")}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <span className={cn("size-3.5 rounded-full border", r.type === t && "border-4 border-primary")} aria-hidden />
                {RESPONSE_TYPE_LABEL[t]}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{TYPE_HELP[t]}</span>
            </button>
          ))}
        </div>

        {acceptsFiles(r) ? (
          <>
            <Field label="Allowed File Types" error={r.allowedTypes.length ? null : "Choose at least one file type."} hint={`Learners see: Accepted ${acceptLabel(r.allowedTypes)}`}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {LEARNER_FILE_GROUPS.map((g) => (
                  <fieldset key={g.label}>
                    <legend className="mb-1 text-xs text-muted-foreground">{g.label}</legend>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {g.exts.map((ext) => (
                        <label key={ext} className="flex items-center gap-1.5 text-sm">
                          <Checkbox checked={r.allowedTypes.includes(ext)} onCheckedChange={(v) => toggleExt(ext, Boolean(v))} aria-label={ext.toUpperCase()} />
                          {ext.toUpperCase()}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Maximum File Size" htmlFor="rmax">
                <div className="flex items-center gap-2">
                  <Input id="rmax" type="number" min={1} max={100} value={r.maxSizeMb} onChange={(e) => set({ maxSizeMb: Math.max(1, Number(e.target.value) || 1) })} className="w-24" />
                  <span className="text-sm text-muted-foreground">MB</span>
                </div>
              </Field>
              <Field label="Maximum Files" htmlFor="rfiles">
                <Input id="rfiles" type="number" min={1} max={10} value={r.maxFiles} onChange={(e) => set({ maxFiles: Math.min(10, Math.max(1, Number(e.target.value) || 1)) })} className="w-24" />
              </Field>
            </div>
            <div className="grid gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={r.allowReplace} onCheckedChange={(v) => set({ allowReplace: Boolean(v) })} />
                Allow learner to replace file before submission
              </label>
              <label className={cn("flex items-center gap-2 text-sm", r.type === "file" && "opacity-60")}>
                <Checkbox checked={r.type === "file" ? true : r.fileRequired} disabled={r.type === "file"} onCheckedChange={(v) => set({ fileRequired: Boolean(v) })} />
                File upload is required{r.type === "file" ? " (always, for file-only answers)" : ""}
              </label>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

/** One-line summary for read-only views. */
export function responseSummary(r: ResponseConfig | undefined) {
  const x = r ?? TEXT_RESPONSE;
  if (!acceptsFiles(x)) return RESPONSE_TYPE_LABEL.text;
  return `${RESPONSE_TYPE_LABEL[x.type]} · ${acceptLabel(x.allowedTypes)} · max ${x.maxSizeMb} MB · ${x.maxFiles} file${x.maxFiles === 1 ? "" : "s"}${x.type === "text_file" && !x.fileRequired ? " · file optional" : ""}`;
}
