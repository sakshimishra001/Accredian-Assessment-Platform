"use client";

import { useState } from "react";
import { Eye } from "lucide-react";
import { Field, SelectField } from "@/components/proto/controls";
import { EmailPreviewDialog } from "@/components/proto/email";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { COMMUNICATION_EVENTS, REMINDER_LABEL, SAMPLE_VALUES, type CommunicationEventKey, type ReminderTimingKey } from "@/lib/communication/templates";
import { toIstInput } from "@/lib/datetime";
import type { getAssessmentCommunication } from "@/server/services/communication";

export type CommunicationData = Awaited<ReturnType<typeof getAssessmentCommunication>>;
type Template = CommunicationData["templates"][number];

export interface EventState {
  enabled: boolean;
  templateId: string;
  customize: boolean;
  overrideSubject: string;
  overrideBody: string;
  reminderTiming: ReminderTimingKey;
  reminderAt: string;
}
export type CommunicationState = Record<CommunicationEventKey, EventState>;

export function toCommunicationState(data: CommunicationData): CommunicationState {
  return Object.fromEntries(
    data.settings.map((s) => [
      s.event,
      {
        enabled: s.enabled,
        templateId: s.templateId ?? "",
        customize: !!(s.overrideSubject || s.overrideBody),
        overrideSubject: s.overrideSubject ?? "",
        overrideBody: s.overrideBody ?? "",
        reminderTiming: (s.reminderTiming ?? "H24") as ReminderTimingKey,
        reminderAt: s.reminderAt ? toIstInput(s.reminderAt) : "",
      },
    ]),
  ) as CommunicationState;
}

/** What the communication service expects (overrides only when customised). */
export function toCommunicationPayload(state: CommunicationState) {
  return Object.fromEntries(
    COMMUNICATION_EVENTS.map((e) => {
      const s = state[e.key];
      return [
        e.key,
        {
          enabled: s.enabled,
          templateId: s.templateId,
          overrideSubject: s.customize ? s.overrideSubject : "",
          overrideBody: s.customize ? s.overrideBody : "",
          ...(e.key === "REMINDER" ? { reminderTiming: s.reminderTiming, reminderAt: s.reminderTiming === "CUSTOM" ? s.reminderAt : "" } : {}),
        },
      ];
    }),
  );
}

/** The Communication step: which emails this assessment sends, with which template, and when. */
export function CommunicationSettings({
  value,
  onChange,
  templates,
  errors,
  disabled,
}: {
  value: CommunicationState;
  onChange: (key: CommunicationEventKey, patch: Partial<EventState>) => void;
  templates: Template[];
  errors: Record<string, string[] | undefined>;
  disabled?: boolean;
}) {
  const [preview, setPreview] = useState<{ template: Template; state: EventState } | null>(null);
  const active = templates.filter((t) => t.status === "ACTIVE");

  return (
    <div className="grid gap-3">
      {active.length === 0 ? (
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
          There are no active email templates yet. Create them under Communication → Templates, then come back to switch emails on.
        </p>
      ) : null}
      {COMMUNICATION_EVENTS.map((e) => {
        const s = value[e.key];
        const template = templates.find((t) => t.id === s.templateId);
        const err = (f: string) => errors[`${e.key}.${f}`]?.[0];
        return (
          <section key={e.key} className="rounded-lg border p-4" aria-label={e.label}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{e.label}</p>
                <p className="text-xs text-muted-foreground">{e.timing}</p>
              </div>
              <Switch checked={s.enabled} onCheckedChange={(v) => onChange(e.key, { enabled: Boolean(v) })} disabled={disabled} aria-label={`Send ${e.label}`} />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field label="Template" error={err("templateId")}>
                <SelectField
                  value={s.templateId}
                  onChange={(v) => onChange(e.key, { templateId: v })}
                  placeholder="Choose a template"
                  disabled={disabled}
                  ariaLabel={`${e.label} template`}
                  options={[...active, ...(template && template.status !== "ACTIVE" ? [template] : [])].map((t) => ({ value: t.id, label: t.status === "ACTIVE" ? t.name : `${t.name} (${t.status.toLowerCase()})` }))}
                  invalid={!!err("templateId")}
                />
              </Field>
              <Button type="button" variant="ghost" size="sm" disabled={!template} onClick={() => template && setPreview({ template, state: s })}>
                <Eye /> Preview
              </Button>
            </div>
            {e.key === "REMINDER" ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="When">
                  <SelectField
                    value={s.reminderTiming}
                    onChange={(v) => onChange(e.key, { reminderTiming: v as ReminderTimingKey })}
                    disabled={disabled}
                    ariaLabel="Reminder timing"
                    options={(Object.keys(REMINDER_LABEL) as ReminderTimingKey[]).map((k) => ({ value: k, label: REMINDER_LABEL[k] }))}
                  />
                </Field>
                {s.reminderTiming === "CUSTOM" ? (
                  <Field label="Reminder date & time (IST)" htmlFor="rem-at" error={err("reminderAt")}>
                    <Input id="rem-at" type="datetime-local" value={s.reminderAt} disabled={disabled} onChange={(ev) => onChange(e.key, { reminderAt: ev.target.value })} />
                  </Field>
                ) : null}
              </div>
            ) : null}
            {e.scheduled && s.enabled ? (
              <p className="mt-2 text-xs text-amber-700">Saved with the assessment. Sending at a set time needs the scheduler, which isn’t connected yet.</p>
            ) : null}
            <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={s.customize} disabled={disabled} onChange={(ev) => onChange(e.key, { customize: ev.target.checked, overrideSubject: s.overrideSubject || template?.subject || "", overrideBody: s.overrideBody || template?.body || "" })} />
              Customise this email for this assessment only (the template isn’t changed)
            </label>
            {s.customize ? (
              <div className="mt-2 grid gap-2">
                <Field label="Subject" error={err("overrideSubject")}>
                  <Input value={s.overrideSubject} disabled={disabled} onChange={(ev) => onChange(e.key, { overrideSubject: ev.target.value })} aria-label={`${e.label} subject`} />
                </Field>
                <Field label="Body" error={err("overrideBody")}>
                  <Textarea rows={5} value={s.overrideBody} disabled={disabled} onChange={(ev) => onChange(e.key, { overrideBody: ev.target.value })} aria-label={`${e.label} body`} />
                </Field>
              </div>
            ) : null}
          </section>
        );
      })}
      <EmailPreviewDialog
        email={
          preview
            ? {
                subject: preview.state.customize ? preview.state.overrideSubject : preview.template.subject,
                body: preview.state.customize ? preview.state.overrideBody : preview.template.body,
                fromName: preview.template.fromName,
                fromEmail: preview.template.fromEmail,
              }
            : null
        }
        values={SAMPLE_VALUES}
        to={`${SAMPLE_VALUES.learner_email} (sample)`}
        onClose={() => setPreview(null)}
        title={`Preview · ${preview?.template.name ?? ""}`}
      />
    </div>
  );
}
