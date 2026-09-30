"use client";

import { useState } from "react";
import { cn } from "cn";
import { Field, SelectField, ToggleRow } from "@/components/proto/controls";
import { PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProto, useProtoActions, type OrgSettings } from "@/prototype/store";
import { useToast } from "@/prototype/toast";

const SECTIONS = ["Organization", "Assessment Defaults", "Notifications", "Security", "Integrations", "General Preferences"] as const;
type SectionKey = (typeof SECTIONS)[number];

const INTEGRATIONS = [
  { name: "Proctoring provider", desc: "Third-party remote proctoring", status: "Not configured" },
  { name: "Email delivery", desc: "Transactional email for invitations and reminders", status: "Not configured" },
  { name: "Single sign-on", desc: "Google Workspace / Microsoft Entra ID", status: "Not configured" },
  { name: "LMS sync", desc: "Import batches and learners from the LMS", status: "Not configured" },
];

export default function SettingsPage() {
  const { settings } = useProto();
  const { updateSettings } = useProtoActions();
  const toast = useToast();
  const [section, setSection] = useState<SectionKey>("Organization");
  const [draft, setDraft] = useState<OrgSettings>(settings);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const set = <K extends keyof OrgSettings>(k: K, v: OrgSettings[K]) => setDraft((d) => ({ ...d, [k]: v }));

  function save() {
    const e: Record<string, string> = {};
    if (!draft.organizationName.trim()) e.organizationName = "Organization name is required.";
    if (!/^\S+@\S+\.\S+$/.test(draft.supportEmail)) e.supportEmail = "Enter a valid email.";
    if (!(draft.defaultDuration >= 5 && draft.defaultDuration <= 600)) e.defaultDuration = "5–600 minutes.";
    if (!(draft.defaultAttempts >= 1 && draft.defaultAttempts <= 10)) e.defaultAttempts = "1–10 attempts.";
    if (!(draft.sessionTimeoutMinutes >= 15 && draft.sessionTimeoutMinutes <= 480)) e.sessionTimeoutMinutes = "15–480 minutes.";
    setErrors(e);
    if (Object.keys(e).length) {
      toast.error("Please fix the highlighted settings");
      return;
    }
    updateSettings(draft);
    toast.success("Settings saved", "Changes apply to this prototype session.");
  }

  return (
    <>
      <PageHeader title="Settings" description="Organization-wide configuration and defaults." />
      <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
        <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSection(s)}
              aria-current={section === s ? "page" : undefined}
              className={cn("rounded-md px-3 py-2 text-left text-sm whitespace-nowrap", section === s ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted")}
            >
              {s}
            </button>
          ))}
        </nav>

        <div className="grid content-start gap-6">
          {section === "Organization" ? (
            <Panel title="Organization">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Organization name" htmlFor="org" error={errors.organizationName}>
                  <Input id="org" value={draft.organizationName} onChange={(e) => set("organizationName", e.target.value)} />
                </Field>
                <Field label="Support email" htmlFor="sup" error={errors.supportEmail}>
                  <Input id="sup" type="email" value={draft.supportEmail} onChange={(e) => set("supportEmail", e.target.value)} />
                </Field>
                <Field label="Timezone" htmlFor="tz" hint="All schedules are shown in this timezone.">
                  <SelectField id="tz" value={draft.timezone} onChange={(v) => set("timezone", v)} options={[{ value: "Asia/Kolkata", label: "Asia/Kolkata (IST)" }, { value: "Asia/Dubai", label: "Asia/Dubai (GST)" }, { value: "Asia/Singapore", label: "Asia/Singapore (SGT)" }]} />
                </Field>
                <Field label="Logo">
                  <div className="flex items-center gap-3">
                    <span className="flex size-9 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">AP</span>
                    <Button variant="outline" size="sm" onClick={() => toast.comingSoon("Logo upload")}>
                      Change logo
                    </Button>
                  </div>
                </Field>
              </div>
            </Panel>
          ) : null}

          {section === "Assessment Defaults" ? (
            <Panel title="Assessment defaults" description="Pre-filled when creating a new assessment.">
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Default duration (minutes)" htmlFor="dd" error={errors.defaultDuration}>
                  <Input id="dd" type="number" value={draft.defaultDuration} onChange={(e) => set("defaultDuration", Number(e.target.value))} />
                </Field>
                <Field label="Default attempts" htmlFor="da" error={errors.defaultAttempts}>
                  <Input id="da" type="number" value={draft.defaultAttempts} onChange={(e) => set("defaultAttempts", Number(e.target.value))} />
                </Field>
                <Field label="Default negative marks" htmlFor="dn" hint="Per wrong objective answer">
                  <Input id="dn" type="number" step={0.25} value={draft.defaultNegativeMarks} disabled={!draft.defaultNegativeMarking} onChange={(e) => set("defaultNegativeMarks", Number(e.target.value))} />
                </Field>
              </div>
              <div className="mt-4 divide-y rounded-lg border px-3 py-3">
                <ToggleRow label="Default negative marking" description="Enable negative marking on new assessments." checked={draft.defaultNegativeMarking} onChange={(v) => set("defaultNegativeMarking", v)} />
                <ToggleRow label="Show results immediately by default" description="Objective scores only." checked={draft.defaultShowResults} onChange={(v) => set("defaultShowResults", v)} />
              </div>
            </Panel>
          ) : null}

          {section === "Notifications" ? (
            <Panel title="Notifications">
              <div className="divide-y rounded-lg border px-3 py-3">
                <ToggleRow label="Email learners when an assessment is scheduled" checked={draft.notifyOnSchedule} onChange={(v) => set("notifyOnSchedule", v)} />
                <ToggleRow label="Notify examiners when scripts are assigned" checked={draft.notifyExaminers} onChange={(v) => set("notifyExaminers", v)} />
                <ToggleRow label="Weekly digest for administrators" checked={draft.weeklyDigest} onChange={(v) => set("weeklyDigest", v)} />
              </div>
              <Field label="Reminder before assessment" htmlFor="rem" className="mt-4 max-w-xs">
                <SelectField id="rem" value={String(draft.reminderHours)} onChange={(v) => set("reminderHours", Number(v))} options={[1, 3, 12, 24, 48].map((h) => ({ value: String(h), label: `${h} hour${h === 1 ? "" : "s"} before` }))} />
              </Field>
            </Panel>
          ) : null}

          {section === "Security" ? (
            <Panel title="Security" description="Prototype mode — these settings are visual only.">
              <Field label="Session timeout (minutes)" htmlFor="st" error={errors.sessionTimeoutMinutes} className="max-w-xs">
                <Input id="st" type="number" value={draft.sessionTimeoutMinutes} onChange={(e) => set("sessionTimeoutMinutes", Number(e.target.value))} />
              </Field>
              <div className="mt-4 divide-y rounded-lg border px-3 py-3">
                <ToggleRow label="Enforce strong passwords" checked={draft.enforceStrongPasswords} onChange={(v) => set("enforceStrongPasswords", v)} />
                <ToggleRow label="Require two-factor authentication for administrators" checked={draft.twoFactorForAdmins} onChange={(v) => set("twoFactorForAdmins", v)} />
              </div>
            </Panel>
          ) : null}

          {section === "Integrations" ? (
            <Panel title="Integrations" bodyClassName="p-0">
              <ul className="divide-y">
                {INTEGRATIONS.map((i) => (
                  <li key={i.name} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium">{i.name}</p>
                      <p className="text-xs text-muted-foreground">{i.desc}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={i.status} />
                      <Button variant="outline" size="sm" onClick={() => toast.info("Coming in a future version.", `${i.name} integration is not part of this prototype.`)}>
                        Connect
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {section === "General Preferences" ? (
            <Panel title="General preferences">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Date format" htmlFor="df">
                  <SelectField id="df" value={draft.dateFormat} onChange={(v) => set("dateFormat", v)} options={["DD MMM YYYY", "DD/MM/YYYY", "YYYY-MM-DD"].map((x) => ({ value: x, label: x }))} />
                </Field>
                <Field label="Language" htmlFor="lang">
                  <SelectField id="lang" value={draft.language} onChange={(v) => set("language", v)} options={["English (India)", "English (US)", "Hindi"].map((x) => ({ value: x, label: x }))} />
                </Field>
              </div>
            </Panel>
          ) : null}

          {section !== "Integrations" ? (
            <div className="sticky bottom-4 flex items-center justify-between gap-2 rounded-lg border bg-card px-4 py-3 shadow-sm">
              <span className="text-sm text-muted-foreground">{dirty ? "You have unsaved changes." : "All changes saved."}</span>
              <div className="flex gap-2">
                <Button variant="ghost" disabled={!dirty} onClick={() => { setDraft(settings); setErrors({}); }}>
                  Discard
                </Button>
                <Button disabled={!dirty} onClick={save}>
                  Save changes
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
