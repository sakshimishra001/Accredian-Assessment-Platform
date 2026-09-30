"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Eye } from "lucide-react";
import { ConfirmDialog, Field, SelectField } from "@/components/proto/controls";
import { EmailPreviewDialog, TemplateContentEditor, VariablesPanel, type EditorHandle } from "@/components/proto/email";
import { EmptyState, PageHeader, Panel, PrototypeNote } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ALL_VARIABLES, SAMPLE_VALUES } from "@/prototype/lib/communication";
import { formatDateTime } from "@/prototype/lib/format";
import { useProto, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { CommTemplate, CommTemplateStatus, CommType } from "@/prototype/types";

const TYPES: CommType[] = ["Assessment", "Reminder", "Assessment Update", "Results"];
const TRIGGERS = [
  "Assessment assigned",
  "Assessment published",
  "Scheduled reminder",
  "Before assessment start",
  "Assessment schedule changed",
  "Assessment cancelled",
  "Results released",
  "Evaluation completed",
];

export default function TemplateEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const s = useProto();
  const { saveTemplate } = useProtoActions();
  const original = s.templates.find((t) => t.id === id);
  const [draft, setDraft] = useState<CommTemplate | null>(original ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const editor = useRef<EditorHandle>(null);

  if (!original || !draft) {
    return (
      <EmptyState
        className="mt-10"
        title="Template not found"
        description="Prototype data resets when the page is refreshed."
        action={<Link href="/admin/communication" className={buttonVariants()}>Back to Communication</Link>}
      />
    );
  }

  const set = (patch: Partial<CommTemplate>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const unknownVars = [...`${draft.subject} ${draft.body}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]).filter((v) => !ALL_VARIABLES.includes(v));

  function save() {
    if (!draft) return;
    const e: Record<string, string> = {};
    if (draft.name.trim().length < 3) e.name = "Enter a template name.";
    if (!draft.subject.trim()) e.subject = "Enter a subject line.";
    if (!draft.body.trim()) e.body = "Enter the email body.";
    if (unknownVars.length) e.body = `Unknown variable${unknownVars.length > 1 ? "s" : ""}: ${unknownVars.map((v) => `{{${v}}}`).join(", ")}`;
    if (!/^\S+@\S+\.\S+$/.test(draft.fromEmail)) e.fromEmail = "Enter a valid email.";
    if (!/^\S+@\S+\.\S+$/.test(draft.replyTo)) e.replyTo = "Enter a valid email.";
    setErrors(e);
    if (Object.keys(e).length) {
      toast.error("Please fix the highlighted fields");
      return;
    }
    saveTemplate({ ...draft, updatedAt: new Date().toISOString() });
    toast.success("Communication template saved.", draft.name);
    router.push("/admin/communication");
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Communication", href: "/admin/communication" }, { label: original.name }]}
        title="Edit Communication Template"
        meta={<StatusBadge status={draft.status} />}
        description={`Global template · last updated ${formatDateTime(original.updatedAt)}. Changes apply to assessments that use this template and haven’t customised it.`}
        actions={
          <>
            <Button variant="ghost" onClick={() => (dirty ? setConfirmLeave(true) : router.push("/admin/communication"))}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => setPreviewing(true)}>
              <Eye /> Preview Email
            </Button>
            <Button onClick={save} disabled={!dirty}>
              Save Template
            </Button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="grid min-w-0 content-start gap-6">
          <Panel title="Template details">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Template Name" htmlFor="tname" error={errors.name}>
                <Input id="tname" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <Field label="Communication Type" htmlFor="ttype">
                <SelectField id="ttype" value={draft.type} onChange={(v) => set({ type: v as CommType })} options={TYPES.map((t) => ({ value: t, label: t }))} />
              </Field>
              <Field label="Trigger" htmlFor="ttrigger" hint="The event this template is meant for.">
                <SelectField id="ttrigger" value={draft.trigger} onChange={(v) => set({ trigger: v })} options={TRIGGERS.map((t) => ({ value: t, label: t }))} />
              </Field>
              <Field label="Status" htmlFor="tstatus" hint={draft.status === "Disabled" ? "Disabled templates can’t be selected for assessments." : undefined}>
                <SelectField id="tstatus" value={draft.status} onChange={(v) => set({ status: v as CommTemplateStatus })} options={["Active", "Draft", "Disabled"].map((t) => ({ value: t, label: t }))} />
              </Field>
            </div>
          </Panel>

          <Panel title="Sender">
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="From Name" htmlFor="fname">
                <Input id="fname" value={draft.fromName} onChange={(e) => set({ fromName: e.target.value })} />
              </Field>
              <Field label="From Email" htmlFor="femail" error={errors.fromEmail}>
                <Input id="femail" value={draft.fromEmail} onChange={(e) => set({ fromEmail: e.target.value })} />
              </Field>
              <Field label="Reply-To" htmlFor="freply" error={errors.replyTo}>
                <Input id="freply" value={draft.replyTo} onChange={(e) => set({ replyTo: e.target.value })} />
              </Field>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Sender configuration will be connected to the organization&apos;s email service in a future phase.</p>
          </Panel>

          <Panel title="Content">
            <TemplateContentEditor subject={draft.subject} body={draft.body} onSubject={(v) => set({ subject: v })} onBody={(v) => set({ body: v })} handle={editor} />
            {errors.subject || errors.body ? <p className="mt-3 text-sm text-destructive">{errors.subject || errors.body}</p> : null}
          </Panel>
        </div>

        <aside className="grid content-start gap-4 xl:sticky xl:top-20 xl:self-start">
          <Panel title="Available Variables" description="Click to insert at the cursor. Previews fill them with sample values.">
            <VariablesPanel onInsert={(v) => editor.current?.insert(v)} />
          </Panel>
          <PrototypeNote>No email is sent from this prototype.</PrototypeNote>
        </aside>
      </div>

      <EmailPreviewDialog email={previewing ? draft : null} values={SAMPLE_VALUES} to={SAMPLE_VALUES.learner_email} onClose={() => setPreviewing(false)} title={`Preview · ${draft.name}`} />
      <ConfirmDialog
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title="Discard changes?"
        description="Your edits to this template haven’t been saved."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => router.push("/admin/communication")}
      />
    </>
  );
}
