"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Eye } from "lucide-react";
import { ConfirmDialog, Field, SelectField } from "@/components/proto/controls";
import { EmailPreviewDialog, TemplateContentEditor, VariablesPanel, type EditorHandle } from "@/components/proto/email";
import { PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { COMMUNICATION_TYPE_LABEL, SAMPLE_VALUES, TEMPLATE_STATUS_LABEL, unknownVariables } from "@/lib/communication/templates";
import { formatDateTime } from "@/prototype/lib/format";
import { useToast } from "@/prototype/toast";
import { createTemplateAction, updateTemplateAction } from "@/server/actions/communication";
import type { getTemplate } from "@/server/services/communication";

type Template = Awaited<ReturnType<typeof getTemplate>>;
type Draft = Omit<Template, "id" | "createdAt" | "updatedAt" | "replyTo"> & { replyTo: string };
type FieldErrors = Record<string, string[] | undefined>;

const TRIGGERS = [
  "Assessment published",
  "Scheduled reminder",
  "Before assessment start",
  "Assessment schedule changed",
  "Assessment cancelled",
  "Results released",
  "Evaluation completed",
];

const BLANK: Draft = {
  name: "",
  type: "ASSESSMENT",
  trigger: "Assessment published",
  subject: "",
  body: "",
  status: "DRAFT",
  fromName: "Accredian Assessments",
  fromEmail: "assessments@accredian.com",
  replyTo: "",
};

/** Template editor: details, sender, content with allowlisted {{variables}}, preview with sample values (nothing is sent). */
export function TemplateEditor({ template }: { template: Template | null }) {
  const router = useRouter();
  const toast = useToast();
  const initial: Draft = template ? { ...template, replyTo: template.replyTo ?? "" } : BLANK;
  const [draft, setDraft] = useState<Draft>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [previewing, setPreviewing] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [pending, startTransition] = useTransition();
  const editor = useRef<EditorHandle>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const unknown = unknownVariables(`${draft.subject} ${draft.body}`);
  const err = (k: string) => errors[k]?.[0];

  function save() {
    startTransition(async () => {
      const result = template ? await updateTemplateAction(template.id, draft) : await createTemplateAction(draft);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        return toast.error(result.fieldErrors ? "Please fix the highlighted fields" : "Couldn’t save the template", result.fieldErrors ? undefined : result.error);
      }
      setErrors({});
      toast.success("Communication template saved.", draft.name);
      if (!template && result.data && "id" in result.data) router.replace(`/admin/communication/templates/${result.data.id}`);
      else router.refresh();
    });
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Communication", href: "/admin/communication" }, { label: template?.name ?? "New template" }]}
        title={template ? "Edit Communication Template" : "New Communication Template"}
        meta={<StatusBadge status={TEMPLATE_STATUS_LABEL[draft.status]} />}
        description={
          template
            ? `Global template · last updated ${formatDateTime(template.updatedAt.toISOString())} IST. Changes apply to assessments that use it and haven’t customised it.`
            : "A reusable email for assessment communications."
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => (dirty ? setConfirmLeave(true) : router.push("/admin/communication"))}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => setPreviewing(true)}>
              <Eye /> Preview Email
            </Button>
            <Button onClick={save} disabled={pending || !dirty}>
              {pending ? "Saving…" : "Save Template"}
            </Button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="grid min-w-0 content-start gap-6">
          <Panel title="Template details">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Template Name" htmlFor="tname" required error={err("name")}>
                <Input id="tname" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <Field label="Communication Type" htmlFor="ttype">
                <SelectField id="ttype" value={draft.type} onChange={(v) => set({ type: v as Draft["type"] })} options={Object.entries(COMMUNICATION_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
              </Field>
              <Field label="Trigger" htmlFor="ttrigger" hint="The event this template is meant for." error={err("trigger")}>
                <SelectField id="ttrigger" value={draft.trigger} onChange={(v) => set({ trigger: v })} options={[...new Set([...TRIGGERS, draft.trigger])].filter(Boolean).map((t) => ({ value: t, label: t }))} />
              </Field>
              <Field label="Status" htmlFor="tstatus" hint={draft.status === "ACTIVE" ? undefined : "Only active templates can be chosen for assessments."} error={err("status")}>
                <SelectField id="tstatus" value={draft.status} onChange={(v) => set({ status: v as Draft["status"] })} options={Object.entries(TEMPLATE_STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
              </Field>
            </div>
          </Panel>

          <Panel title="Sender">
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="From Name" htmlFor="fname" error={err("fromName")}>
                <Input id="fname" value={draft.fromName} onChange={(e) => set({ fromName: e.target.value })} />
              </Field>
              <Field label="From Email" htmlFor="femail" error={err("fromEmail")}>
                <Input id="femail" value={draft.fromEmail} onChange={(e) => set({ fromEmail: e.target.value })} />
              </Field>
              <Field label="Reply-To" htmlFor="freply" hint="Optional" error={err("replyTo")}>
                <Input id="freply" value={draft.replyTo} onChange={(e) => set({ replyTo: e.target.value })} />
              </Field>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">No email service is connected yet: emails are recorded in Communication History as “not delivered”.</p>
          </Panel>

          <Panel title="Content">
            <TemplateContentEditor subject={draft.subject} body={draft.body} onSubject={(v) => set({ subject: v })} onBody={(v) => set({ body: v })} handle={editor} />
            {unknown.length ? <p className="mt-3 text-sm text-amber-700">Unknown variable{unknown.length > 1 ? "s" : ""}: {unknown.map((v) => `{{${v}}}`).join(", ")} — saving will be refused.</p> : null}
            {err("subject") || err("body") ? (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {err("subject") ?? err("body")}
              </p>
            ) : null}
          </Panel>
        </div>

        <aside className="grid content-start gap-4 xl:sticky xl:top-20 xl:self-start">
          <Panel title="Available Variables" description="Click to insert at the cursor. Previews fill them with sample values.">
            <VariablesPanel onInsert={(v) => editor.current?.insert(v)} />
          </Panel>
        </aside>
      </div>

      <EmailPreviewDialog email={previewing ? draft : null} values={SAMPLE_VALUES} to={SAMPLE_VALUES.learner_email} onClose={() => setPreviewing(false)} title={`Preview · ${draft.name || "New template"}`} />
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
