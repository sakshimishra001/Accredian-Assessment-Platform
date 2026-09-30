"use client";

// Assessment-level communication: WHICH email, to WHOM and WHEN for this assessment.
// Global template management lives in the Communication module; this never edits templates.

import { useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Eye, Info, Pencil, RotateCcw, Users } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { REMINDER_LABEL, reminderProblem, reminderTimingText, valuesForAssessment } from "@/prototype/lib/communication";
import { formatDate, formatDateTime, formatNumber, formatTime } from "@/prototype/lib/format";
import { useLookups, useProto } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { Assessment, AssessmentCommunication, CommSetting, CommTemplate, CommType, ReminderTiming } from "@/prototype/types";
import { Field, Pagination, SearchInput, SelectField, usePagination } from "./controls";
import { EmailPreviewDialog, TemplateContentEditor, VariablesPanel, type EditorHandle, type EmailContent } from "./email";
import { Panel } from "./page";

export type CommKey = "assignment" | "reminder" | "startingSoon" | "rescheduled" | "cancelled" | "resultPublished";

export const COMM_META: Record<CommKey, { label: string; type: CommType; timing: string }> = {
  assignment: { label: "Assignment email", type: "Assessment", timing: "Immediately after publishing" },
  reminder: { label: "Reminder", type: "Reminder", timing: "" },
  startingSoon: { label: "Exam Starting Soon", type: "Reminder", timing: "1 hour before the assessment" },
  rescheduled: { label: "Exam Rescheduled", type: "Assessment Update", timing: "When the schedule changes" },
  cancelled: { label: "Exam Cancelled", type: "Assessment Update", timing: "If the assessment is cancelled" },
  resultPublished: { label: "Result Published", type: "Results", timing: "When results are published" },
};

export interface CommContext {
  form: Assessment;
  comm: AssessmentCommunication;
  startIso: string;
  endIso: string;
}

export function recipientCount(comm: AssessmentCommunication, batchSize: number) {
  return comm.audience === "batch" ? batchSize : comm.selectedLearnerIds.length;
}

export function timingFor(key: CommKey, comm: AssessmentCommunication, startIso: string) {
  return key === "reminder" ? reminderTimingText(comm.reminder, startIso) : COMM_META[key].timing;
}

/** All problems that block publishing (also used by the wizard's validation). */
export function communicationProblems(ctx: CommContext, templates: CommTemplate[], batchSize: number, assignmentAt: number): Record<string, string> {
  const e: Record<string, string> = {};
  const { form, comm } = ctx;
  if (!form.batchId) e.batch = "Select a batch before configuring recipients.";
  if (comm.audience === "selected" && comm.selectedLearnerIds.length === 0) e.recipients = "Select at least one learner, or send to the entire batch.";
  (Object.keys(COMM_META) as CommKey[]).forEach((k) => {
    const setting = comm[k];
    if (!setting.enabled) return;
    const t = templates.find((x) => x.id === setting.templateId);
    if (!t) e[k] = "Choose a template.";
    else if (t.status === "Disabled") e[k] = "This template is disabled. Select another template.";
  });
  const r = reminderProblem(comm.reminder, ctx.startIso, assignmentAt);
  if (r) e.reminder = e.reminder ?? r;
  if (batchSize === 0 && form.batchId) e.batch = "The selected batch has no learners.";
  return e;
}

/** Effective subject/body for a communication: the assessment's own copy if customised, else the template. */
export function contentFor(setting: CommSetting, templates: CommTemplate[]): EmailContent | null {
  const t = templates.find((x) => x.id === setting.templateId);
  if (!t) return null;
  return { subject: setting.override?.subject ?? t.subject, body: setting.override?.body ?? t.body, fromName: t.fromName, fromEmail: t.fromEmail };
}

export function useAssessmentEmailValues(form: Assessment, startIso: string, endIso: string) {
  const s = useProto();
  const lookup = useLookups();
  const batch = lookup.batch(form.batchId);
  const first = batch ? lookup.learner(batch.learnerIds[0]) : undefined;
  return {
    first,
    values: valuesForAssessment({
      name: form.name,
      courseName: lookup.course(form.courseId)?.name,
      batchName: batch?.name,
      start: startIso,
      end: endIso,
      durationMinutes: form.durationMinutes,
      learnerName: first?.name,
      learnerEmail: first?.email,
      supportEmail: s.settings.supportEmail,
      companyName: s.settings.organizationName,
    }),
  };
}

// ---------------------------------------------------------------------------

export function CommunicationStep({
  form,
  comm,
  setComm,
  setBatch,
  startIso,
  endIso,
  errors,
}: {
  form: Assessment;
  comm: AssessmentCommunication;
  setComm: (c: AssessmentCommunication) => void;
  setBatch: (batchId: string) => void;
  startIso: string;
  endIso: string;
  errors: Record<string, string>;
}) {
  const s = useProto();
  const lookup = useLookups();
  const toast = useToast();
  const batch = lookup.batch(form.batchId);
  const batchSize = batch?.learnerIds.length ?? 0;
  const recipients = recipientCount(comm, batchSize);
  const { values, first } = useAssessmentEmailValues(form, startIso, endIso);
  const [previewKey, setPreviewKey] = useState<CommKey | null>(null);
  const [editingKey, setEditingKey] = useState<CommKey | null>(null);
  const [viewLearners, setViewLearners] = useState(false);
  const [pickLearners, setPickLearners] = useState(false);
  const [changingBatch, setChangingBatch] = useState(false);
  const [moreOpen, setMoreOpen] = useState(comm.startingSoon.enabled || comm.rescheduled.enabled || comm.cancelled.enabled);

  const setSetting = <K extends CommKey>(k: K, patch: Partial<AssessmentCommunication[K]>) => setComm({ ...comm, [k]: { ...comm[k], ...patch } });
  const templatesOfType = (type: CommType) => s.templates.filter((t) => t.type === type);
  const templateOptions = (type: CommType) =>
    templatesOfType(type).map((t) => ({ value: t.id, label: t.status === "Active" ? t.name : `${t.name} (${t.status})` }));
  const nothingEnabled = !(Object.keys(COMM_META) as CommKey[]).some((k) => comm[k].enabled);
  const recipientsText = batch ? `${formatNumber(recipients)} learner${recipients === 1 ? "" : "s"}` : "—";

  return (
    <div className="grid gap-6">
      <Panel title="Communication" description="Configure how learners will be notified about this assessment.">
        <p className="mb-4 flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0" /> Communication timings are based on the current assessment schedule ({formatDateTime(startIso)} IST).
        </p>
        <CommunicationWorkflow comm={comm} templates={s.templates} startIso={startIso} recipientsText={recipientsText} />
        {nothingEnabled ? (
          <p className="mt-4 flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
            <AlertTriangle className="size-4 shrink-0" /> Communication is disabled for this assessment.
          </p>
        ) : null}
      </Panel>

      <Panel
        title="Recipients"
        description="Taken from the batch selected in Basic Details. No email addresses to enter."
        actions={
          batch ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setChangingBatch((c) => !c)}>
                Change Batch
              </Button>
              <Button variant="outline" size="sm" onClick={() => setViewLearners(true)}>
                <Users /> View Learners
              </Button>
            </>
          ) : null
        }
      >
        {errors.batch ? <p className="mb-3 text-sm text-destructive">{errors.batch}</p> : null}
        {!batch || changingBatch ? (
          <Field label="Batch" htmlFor="comm-batch" hint={changingBatch ? "Changing the batch here also changes the batch this assessment is assigned to." : undefined} className="mb-4 max-w-md">
            <SelectField
              id="comm-batch"
              value={form.batchId}
              onChange={(v) => {
                setBatch(v);
                setChangingBatch(false);
                if (v) toast.info("Recipients updated", `${lookup.batch(v)?.name} · ${formatNumber(lookup.batch(v)?.learnerIds.length ?? 0)} learners`);
              }}
              placeholder="Select a batch"
              options={s.batches.filter((b) => !form.courseId || b.courseId === form.courseId).map((b) => ({ value: b.id, label: `${b.name} · ${formatNumber(b.learnerIds.length)} learners` }))}
            />
          </Field>
        ) : null}
        {batch ? (
          <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
            <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Batch</dt>
              <dd className="font-medium">{batch.name}</dd>
              <dt className="text-muted-foreground">Learners</dt>
              <dd className="font-medium tabular-nums">{recipientsText}</dd>
            </dl>
            <div className="flex gap-2" role="radiogroup" aria-label="Recipients">
              {(
                [
                  ["batch", "Entire Batch"],
                  ["selected", "Selected Learners"],
                ] as const
              ).map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={comm.audience === v}
                  onClick={() => {
                    setComm({ ...comm, audience: v });
                    if (v === "selected" && comm.selectedLearnerIds.length === 0) setPickLearners(true);
                  }}
                  className={cn("rounded-md border px-3 py-1.5 text-sm", comm.audience === v ? "border-primary bg-accent/60 font-medium ring-1 ring-primary" : "hover:bg-muted")}
                >
                  {l}
                </button>
              ))}
            </div>
            {comm.audience === "selected" ? (
              <div className="flex items-center gap-2 text-sm md:col-span-2">
                <span className="text-muted-foreground">{formatNumber(comm.selectedLearnerIds.length)} of {formatNumber(batchSize)} learners selected.</span>
                <Button variant="ghost" size="sm" onClick={() => setPickLearners(true)}>
                  Choose learners
                </Button>
              </div>
            ) : null}
            {errors.recipients ? <p className="text-sm text-destructive md:col-span-2">{errors.recipients}</p> : null}
          </div>
        ) : null}
      </Panel>

      <CommSection
        title="Assignment Communication"
        toggleLabel="Send assignment email"
        setting={comm.assignment}
        onToggle={(v) => setSetting("assignment", { enabled: v })}
        offText="No assignment communication will be sent."
        options={templateOptions("Assessment")}
        onTemplate={(id) => setSetting("assignment", { templateId: id, override: undefined })}
        error={errors.assignment}
      >
        <EmailDetails
          setting={comm.assignment}
          templates={s.templates}
          to={batch ? `${recipientsText} in ${batch.name}` : "Select a batch"}
          timing={COMM_META.assignment.timing}
          onEdit={() => setEditingKey("assignment")}
          onPreview={() => setPreviewKey("assignment")}
        />
      </CommSection>

      <CommSection
        title="Reminder"
        toggleLabel="Send reminder"
        setting={comm.reminder}
        onToggle={(v) => setSetting("reminder", { enabled: v })}
        offText="No reminder will be sent."
        options={templateOptions("Reminder")}
        onTemplate={(id) => setSetting("reminder", { templateId: id, override: undefined })}
        error={errors.reminder}
      >
        <div className="grid gap-3">
          <Field label="Timing">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Reminder timing">
              {(Object.keys(REMINDER_LABEL) as ReminderTiming[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={comm.reminder.timing === t}
                  onClick={() => setSetting("reminder", { timing: t })}
                  className={cn("rounded-md border px-3 py-1.5 text-sm", comm.reminder.timing === t ? "border-primary bg-accent/60 font-medium ring-1 ring-primary" : "hover:bg-muted")}
                >
                  {REMINDER_LABEL[t]}
                </button>
              ))}
            </div>
          </Field>
          {comm.reminder.timing === "custom" ? (
            <div className="grid max-w-md grid-cols-2 gap-2">
              <Field label="Date" htmlFor="rem-date">
                <Input id="rem-date" type="date" value={comm.reminder.customDate} onChange={(e) => setSetting("reminder", { customDate: e.target.value })} />
              </Field>
              <Field label="Time" htmlFor="rem-time">
                <Input id="rem-time" type="time" value={comm.reminder.customTime} onChange={(e) => setSetting("reminder", { customTime: e.target.value })} />
              </Field>
            </div>
          ) : null}
          <EmailDetails
            setting={comm.reminder}
            templates={s.templates}
            to={batch ? `${recipientsText} in ${batch.name}` : "Select a batch"}
            timing={reminderTimingText(comm.reminder, startIso)}
            onEdit={() => setEditingKey("reminder")}
            onPreview={() => setPreviewKey("reminder")}
            previewLabel="Preview Reminder"
          />
        </div>
      </CommSection>

      <section className="rounded-lg border bg-card">
        <button type="button" onClick={() => setMoreOpen((o) => !o)} aria-expanded={moreOpen} className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left">
          <span>
            <span className="block text-sm font-semibold">Additional Communications</span>
            <span className="block text-xs text-muted-foreground">Optional updates for the assessment lifecycle.</span>
          </span>
          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", moreOpen && "rotate-180")} />
        </button>
        {moreOpen ? (
          <ul className="divide-y border-t">
            {(["startingSoon", "rescheduled", "cancelled", "resultPublished"] as const).map((k) => {
              const setting = comm[k];
              return (
                <li key={k} className="grid gap-3 px-4 py-3 md:grid-cols-[14rem_1fr_auto] md:items-center">
                  <label className="flex items-center gap-3">
                    <Switch checked={setting.enabled} onCheckedChange={(v) => setSetting(k, { enabled: Boolean(v) })} aria-label={COMM_META[k].label} />
                    <span>
                      <span className="block text-sm font-medium">{COMM_META[k].label}</span>
                      <span className="block text-xs text-muted-foreground">{COMM_META[k].timing}</span>
                    </span>
                  </label>
                  <div>
                    <SelectField
                      value={setting.templateId}
                      onChange={(id) => setSetting(k, { templateId: id, override: undefined })}
                      options={templateOptions(COMM_META[k].type)}
                      ariaLabel={`${COMM_META[k].label} template`}
                      disabled={!setting.enabled}
                    />
                    {errors[k] ? <p className="mt-1 text-xs text-destructive">{errors[k]}</p> : null}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setPreviewKey(k)} disabled={!s.templates.some((t) => t.id === setting.templateId)}>
                    <Eye /> Preview
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      <EmailPreviewDialog
        email={previewKey ? contentFor(comm[previewKey], s.templates) : null}
        values={values}
        to={batch ? `${first?.email ?? ""}${recipients > 1 ? ` and ${formatNumber(recipients - 1)} other learners` : ""}` : "—"}
        onClose={() => setPreviewKey(null)}
        title={previewKey ? `Preview · ${COMM_META[previewKey].label}` : undefined}
        context={
          previewKey ? (
            <p className="text-xs text-muted-foreground">
              Showing the email as {first?.name ?? "the first recipient"} will see it · {timingFor(previewKey, comm, startIso)}
              {comm[previewKey].override ? " · customised for this assessment" : ""}
            </p>
          ) : null
        }
      />

      <EditContentDialog
        key={editingKey ?? "none"}
        open={editingKey !== null}
        label={editingKey ? COMM_META[editingKey].label : ""}
        setting={editingKey ? comm[editingKey] : null}
        templates={s.templates}
        values={values}
        onClose={() => setEditingKey(null)}
        onSave={(override) => {
          if (!editingKey) return;
          setSetting(editingKey, { override });
          toast.success(override ? "Assessment communication updated" : "Reset to template", override ? "Only this assessment uses the edited content." : "This assessment now uses the template content.");
          setEditingKey(null);
        }}
      />

      <LearnerListDialog open={viewLearners} onOpenChange={setViewLearners} batchId={form.batchId} selectable={false} />
      <LearnerListDialog
        key={pickLearners ? "picking" : "idle"}
        open={pickLearners}
        onOpenChange={setPickLearners}
        batchId={form.batchId}
        selectable
        selected={comm.selectedLearnerIds}
        onSave={(ids) => {
          setComm({ ...comm, audience: ids.length ? "selected" : "batch", selectedLearnerIds: ids });
          toast.success("Recipients updated", `${formatNumber(ids.length)} learners selected.`);
        }}
      />
    </div>
  );
}

function CommSection({
  title,
  toggleLabel,
  setting,
  onToggle,
  offText,
  options,
  onTemplate,
  error,
  children,
}: {
  title: string;
  toggleLabel: string;
  setting: CommSetting;
  onToggle: (v: boolean) => void;
  offText: string;
  options: { value: string; label: string }[];
  onTemplate: (id: string) => void;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <Panel
      title={title}
      actions={
        <label className="flex items-center gap-2 text-sm">
          {toggleLabel}
          <Switch checked={setting.enabled} onCheckedChange={(v) => onToggle(Boolean(v))} aria-label={toggleLabel} />
        </label>
      }
    >
      {!setting.enabled ? (
        <p className="text-sm text-muted-foreground">{offText}</p>
      ) : (
        <div className="grid gap-4">
          <Field label="Template" error={error} className="max-w-md">
            <SelectField value={setting.templateId} onChange={onTemplate} options={options} ariaLabel={`${title} template`} invalid={!!error} />
          </Field>
          {children}
        </div>
      )}
    </Panel>
  );
}

function EmailDetails({
  setting,
  templates,
  to,
  timing,
  onEdit,
  onPreview,
  previewLabel = "Preview Email",
}: {
  setting: CommSetting;
  templates: CommTemplate[];
  to: string;
  timing: string;
  onEdit: () => void;
  onPreview: () => void;
  previewLabel?: string;
}) {
  const c = contentFor(setting, templates);
  if (!c) return null;
  return (
    <div className="rounded-lg border">
      <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 px-4 py-3 text-sm">
        <dt className="text-muted-foreground">Subject</dt>
        <dd className="font-mono text-xs leading-5">{c.subject}</dd>
        <dt className="text-muted-foreground">From</dt>
        <dd>
          {c.fromName} <span className="text-muted-foreground">&lt;{c.fromEmail}&gt;</span>
        </dd>
        <dt className="text-muted-foreground">To</dt>
        <dd>{to}</dd>
        <dt className="text-muted-foreground">When</dt>
        <dd>{timing}</dd>
      </dl>
      <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-2">
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil /> Edit Content
        </Button>
        <Button variant="outline" size="sm" onClick={onPreview}>
          <Eye /> {previewLabel}
        </Button>
        {setting.override ? <span className="ml-auto rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground">Customised for this assessment</span> : null}
      </div>
    </div>
  );
}

function EditContentDialog({
  open,
  label,
  setting,
  templates,
  values,
  onClose,
  onSave,
}: {
  open: boolean;
  label: string;
  setting: CommSetting | null;
  templates: CommTemplate[];
  values: Record<string, string>;
  onClose: () => void;
  onSave: (override: { subject: string; body: string } | undefined) => void;
}) {
  const template = templates.find((t) => t.id === setting?.templateId);
  const [subject, setSubject] = useState(setting?.override?.subject ?? template?.subject ?? "");
  const [body, setBody] = useState(setting?.override?.body ?? template?.body ?? "");
  const [previewing, setPreviewing] = useState(false);
  const editor = useRef<EditorHandle>(null);
  if (!template) return null;
  const same = subject === template.subject && body === template.body;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Edit content · {label}</DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <Info className="size-3.5" /> Editing communication for this assessment only. The global “{template.name}” template is not changed.
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[65vh] gap-4 overflow-auto lg:grid-cols-[1fr_14rem]">
          <TemplateContentEditor subject={subject} body={body} onSubject={setSubject} onBody={setBody} handle={editor} />
          <div className="rounded-lg border p-3">
            <p className="mb-2 text-xs font-medium">Available Variables</p>
            <VariablesPanel onInsert={(v) => editor.current?.insert(v)} />
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => {
              setSubject(template.subject);
              setBody(template.body);
            }}
            disabled={same}
          >
            <RotateCcw /> Reset to Template
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setPreviewing(true)}>
              <Eye /> Preview
            </Button>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => onSave(same ? undefined : { subject, body })}>Save for this assessment</Button>
          </div>
        </DialogFooter>
        <EmailPreviewDialog
          email={previewing ? { subject, body, fromName: template.fromName, fromEmail: template.fromEmail } : null}
          values={values}
          to={values.learner_email}
          onClose={() => setPreviewing(false)}
          title={`Preview · ${label}`}
        />
      </DialogContent>
    </Dialog>
  );
}

export function LearnerListDialog({
  open,
  onOpenChange,
  batchId,
  selectable,
  selected = [],
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  batchId: string;
  selectable: boolean;
  selected?: string[];
  onSave?: (ids: string[]) => void;
}) {
  const s = useProto();
  const lookup = useLookups();
  const batch = lookup.batch(batchId);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>(selected);
  const rows = s.learners.filter((l) => l.batchId === batchId).filter((l) => (q.trim() ? `${l.name} ${l.email}`.toLowerCase().includes(q.trim().toLowerCase()) : true));
  const pager = usePagination(rows, 8);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setPicked(selected);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{selectable ? "Choose learners" : "Recipients"}</DialogTitle>
          <DialogDescription>
            {batch?.name} · {formatNumber(batch?.learnerIds.length ?? 0)} learners
          </DialogDescription>
        </DialogHeader>
        <SearchInput value={q} onChange={setQ} placeholder="Search learners…" />
        <div className="rounded-lg border">
          <ul className="divide-y">
            {pager.slice.map((l) => (
              <li key={l.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                {selectable ? <Checkbox checked={picked.includes(l.id)} onCheckedChange={(v) => setPicked((p) => (v ? [...p, l.id] : p.filter((x) => x !== l.id)))} aria-label={`Select ${l.name}`} /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{l.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{l.email}</span>
                </span>
                <span className="text-xs text-muted-foreground">{l.status}</span>
              </li>
            ))}
          </ul>
          <Pagination {...pager} />
        </div>
        <DialogFooter>
          {selectable ? (
            <>
              <span className="mr-auto self-center text-xs text-muted-foreground">{formatNumber(picked.length)} selected</span>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  onSave?.(picked);
                  onOpenChange(false);
                }}
              >
                Use {formatNumber(picked.length)} learners
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Workflow visualization
// ---------------------------------------------------------------------------

export function CommunicationWorkflow({
  comm,
  templates,
  startIso,
  recipientsText,
}: {
  comm: AssessmentCommunication;
  templates: CommTemplate[];
  startIso: string;
  recipientsText: string;
}) {
  const name = (s: CommSetting) => templates.find((t) => t.id === s.templateId)?.name ?? "—";
  type Node = { title: string; on: boolean; milestone?: boolean; template?: string; timing: string; recipients?: string };
  const nodes: Node[] = [
    { title: "Assessment Published", on: true, milestone: true, timing: "When you publish" },
    { title: "Assignment Email", on: comm.assignment.enabled, template: name(comm.assignment), timing: COMM_META.assignment.timing, recipients: recipientsText },
    { title: "Learner Receives Email", on: comm.assignment.enabled, milestone: true, timing: comm.assignment.enabled ? "Learners get the assessment link" : "No assignment email — learners see it on their dashboard" },
    { title: "Reminder", on: comm.reminder.enabled, template: name(comm.reminder), timing: reminderTimingText(comm.reminder, startIso), recipients: recipientsText },
    ...(comm.startingSoon.enabled ? [{ title: "Exam Starting Soon", on: true, template: name(comm.startingSoon), timing: COMM_META.startingSoon.timing, recipients: recipientsText }] : []),
    { title: "Assessment Starts", on: true, milestone: true, timing: `${formatDate(startIso)}, ${formatTime(startIso)} IST` },
    { title: "Result Published", on: comm.resultPublished.enabled, template: name(comm.resultPublished), timing: COMM_META.resultPublished.timing, recipients: recipientsText },
  ];
  return (
    <ol className="grid gap-0" aria-label="Communication workflow">
      {nodes.map((n, i) => (
        <li key={n.title} className="relative grid grid-cols-[1.5rem_1fr] gap-3 pb-4 last:pb-0">
          {i < nodes.length - 1 ? <span className="absolute top-5 left-[0.6875rem] h-full w-px bg-border" aria-hidden /> : null}
          <span
            className={cn(
              "relative z-10 mt-0.5 flex size-4 items-center justify-center justify-self-center rounded-full border-2",
              n.milestone ? "border-muted-foreground/50 bg-background" : n.on ? "border-primary bg-primary" : "border-border bg-background",
            )}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("text-sm", n.milestone ? "text-muted-foreground" : "font-medium", !n.on && !n.milestone && "text-muted-foreground")}>{n.title}</span>
              {!n.milestone ? (
                <span className={cn("rounded-full px-1.5 text-[11px] font-medium", n.on ? "bg-emerald-50 text-emerald-700" : "bg-muted text-muted-foreground")}>{n.on ? "On" : "Off"}</span>
              ) : null}
            </div>
            {!n.milestone && n.on ? (
              <p className="text-xs text-muted-foreground">
                {n.template} · {n.timing} · {n.recipients}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{n.milestone ? n.timing : "Not sent"}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
