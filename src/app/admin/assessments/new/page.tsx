"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Circle, Eye, FileStack, Mail, Pencil, Send, ShieldAlert } from "lucide-react";
import { cn } from "cn";
import {
  COMM_META,
  CommunicationStep,
  communicationProblems,
  contentFor,
  recipientCount,
  timingFor,
  useAssessmentEmailValues,
  type CommKey,
} from "@/components/proto/communication-step";
import { ConfirmDialog, Field, SearchInput, SelectField, Stepper, ToggleRow } from "@/components/proto/controls";
import { EmailPreviewDialog } from "@/components/proto/email";
import { DetailList, EmptyState, PageHeader, Panel } from "@/components/proto/page";
import { PaperStats, PaperStructure } from "@/components/proto/paper-summary";
import { StatusBadge } from "@/components/proto/status-badge";
import { withSuspense } from "@/components/proto/suspense-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatDateTime, formatDuration, formatNumber, fromIstParts, toIstParts } from "@/prototype/lib/format";
import { paperTotals } from "@/prototype/lib/paper";
import { RESULT_VISIBILITY_LABEL } from "@/prototype/lib/assessment";
import { defaultCommunication, reminderAt, resolveVariables } from "@/prototype/lib/communication";
import { DEMO_DAY_START } from "@/prototype/lib/random";
import { newId, useLookups, useProto, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { Assessment, AssessmentCommunication, AssessmentType, CommHistoryEntry, ResultVisibility, TimingMode } from "@/prototype/types";

const STEPS = ["Basic details", "Question paper", "Configuration", "Schedule", "Communication", "Review & publish"];
const LAST = STEPS.length - 1;
const COMM_STEP = 4;
const COMM_ORDER: CommKey[] = ["assignment", "reminder", "startingSoon", "rescheduled", "cancelled", "resultPublished"];

interface ScheduleForm {
  mode: "later" | "now";
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

function blankAssessment(defaults: { duration: number; attempts: number; negative: boolean; negativeMarks: number; showResults: boolean }): Assessment {
  const start = new Date(DEMO_DAY_START + 7 * 86400000 + 10 * 3600000).toISOString();
  const end = new Date(DEMO_DAY_START + 7 * 86400000 + 13 * 3600000).toISOString();
  return {
    id: newId("a"),
    name: "",
    courseId: "",
    batchId: "",
    paperId: null,
    type: "Mixed",
    description: "",
    instructions: "Read every question carefully before answering.\nThe timer starts when you begin and cannot be paused.\nAnswers are saved automatically.",
    durationMinutes: defaults.duration,
    maxAttempts: defaults.attempts,
    negativeMarking: defaults.negative,
    negativeMarks: defaults.negativeMarks,
    settings: {
      timingMode: "window",
      randomizeQuestions: false,
      randomizeOptions: false,
      showResultsImmediately: defaults.showResults,
      resultVisibility: "score",
      allowResume: true,
      showQuestionPalette: true,
      allowMarkForReview: true,
      proctoring: false,
    },
    schedule: { mode: "later", start, end, notifyLearners: true, sendReminder: true },
    status: "Draft",
    examinerIds: [],
    createdAt: new Date().toISOString(),
    attempted: 0,
  };
}

function toScheduleForm(a: Assessment): ScheduleForm {
  const s = toIstParts(a.schedule.start);
  const e = toIstParts(a.schedule.end);
  return { mode: a.schedule.mode, startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time };
}

// Validation runs from event handlers (Next / Publish), so reading the clock there is fine.
const currentTime = () => Date.now();

/** The schedule as currently entered — used for communication timings and previews. */
function plannedSchedule(sched: ScheduleForm, form: Assessment, nowMs: number) {
  if (sched.mode === "now") return { start: new Date(nowMs).toISOString(), end: new Date(nowMs + Math.max(form.durationMinutes + 30, 180) * 60000).toISOString() };
  return { start: fromIstParts(sched.startDate, sched.startTime) ?? form.schedule.start, end: fromIstParts(sched.endDate, sched.endTime) ?? form.schedule.end };
}

function CreateAssessmentWizard() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const state = useProto();
  const lookup = useLookups();
  const { saveAssessment, addCommHistory } = useProtoActions();

  const editing = params.get("edit") ? state.assessments.find((a) => a.id === params.get("edit")) : undefined;
  const presetPaper = params.get("paper") ? state.papers.find((p) => p.id === params.get("paper")) : undefined;

  const [form, setForm] = useState<Assessment>(() => {
    if (editing) {
      if (editing.communication) return editing;
      // Older assessments only stored two notification flags; map them onto the communication plan.
      const d = defaultCommunication(state.templates);
      return {
        ...editing,
        communication: { ...d, assignment: { ...d.assignment, enabled: editing.schedule.notifyLearners }, reminder: { ...d.reminder, enabled: editing.schedule.sendReminder } },
      };
    }
    const base = blankAssessment({
      duration: state.settings.defaultDuration,
      attempts: state.settings.defaultAttempts,
      negative: state.settings.defaultNegativeMarking,
      negativeMarks: state.settings.defaultNegativeMarks,
      showResults: state.settings.defaultShowResults,
    });
    if (presetPaper) {
      const t = paperTotals(presetPaper);
      const batch = lookup.batch(presetPaper.batchId);
      return {
        ...base,
        name: presetPaper.name.replace(/^.*?–\s*/, `${lookup.course(presetPaper.courseId)?.name} – `),
        courseId: presetPaper.courseId,
        batchId: batch?.id ?? "",
        paperId: presetPaper.id,
        type: t.subjective === 0 ? "Objective" : t.objective === 0 ? "Subjective" : "Mixed",
        durationMinutes: presetPaper.durationMinutes,
      };
    }
    return { ...base, communication: defaultCommunication(state.templates) };
  });
  const [sched, setSched] = useState<ScheduleForm>(() => toScheduleForm(editing ?? form));
  const initialStep = Math.min(LAST, Math.max(0, Number(params.get("step")) || 0));
  const [step, setStep] = useState(initialStep);
  const [maxReached, setMaxReached] = useState(editing ? LAST : initialStep);
  // "Start immediately" schedules are anchored to when the wizard opened, so previews stay stable.
  const [openedAt] = useState(() => Date.now());
  const [previewKey, setPreviewKey] = useState<CommKey | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [savedOnce, setSavedOnce] = useState(Boolean(editing));
  const [confirmSchedule, setConfirmSchedule] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  // Warn before a full page unload with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const update = (patch: Partial<Assessment>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };
  const updateSettings = (patch: Partial<Assessment["settings"]>) => update({ settings: { ...form.settings, ...patch } });
  const updateSched = (patch: Partial<ScheduleForm>) => {
    setSched((s) => ({ ...s, ...patch }));
    setDirty(true);
  };

  const paper = lookup.paper(form.paperId);
  const totals = paper ? paperTotals(paper) : null;
  const batch = lookup.batch(form.batchId);
  const course = lookup.course(form.courseId);
  const comm: AssessmentCommunication = form.communication ?? defaultCommunication(state.templates);
  const setComm = (c: AssessmentCommunication) => update({ communication: c });
  const batchSize = batch?.learnerIds.length ?? 0;
  const recipients = recipientCount(comm, batchSize);
  const planned = plannedSchedule(sched, form, openedAt);
  const { values: emailValues, first: firstLearner } = useAssessmentEmailValues(form, planned.start, planned.end);
  const enabledComms = COMM_ORDER.filter((k) => comm[k].enabled);
  const commErrors = () =>
    // The assignment email goes out on publish; the wizard's open time stands in for it.
    communicationProblems({ form, comm, startIso: planned.start, endIso: planned.end }, state.templates, batchSize, openedAt);

  // --- validation per step ----------------------------------------------------
  function validate(i: number): Record<string, string> {
    const e: Record<string, string> = {};
    if (i === 0) {
      if (form.name.trim().length < 3) e.name = "Enter an assessment name (at least 3 characters).";
      if (!form.courseId) e.courseId = "Choose a course.";
      if (!form.batchId) e.batchId = "Choose a batch.";
    }
    if (i === 2) {
      if (!(form.durationMinutes >= 5 && form.durationMinutes <= 600)) e.durationMinutes = "Duration must be between 5 and 600 minutes.";
      if (!(form.maxAttempts >= 1 && form.maxAttempts <= 10)) e.maxAttempts = "Attempts must be between 1 and 10.";
      if (form.negativeMarking && !(form.negativeMarks > 0 && form.negativeMarks <= 5)) e.negativeMarks = "Enter negative marks between 0.25 and 5.";
    }
    if (i === 1 && !form.paperId) e.paperId = "Select an approved question paper to continue.";
    if (i === 3 && sched.mode === "later") {
      const start = fromIstParts(sched.startDate, sched.startTime);
      const end = fromIstParts(sched.endDate, sched.endTime);
      if (!start) e.start = "Enter a valid start date and time.";
      if (!end) e.end = "Enter a valid end date and time.";
      if (start && new Date(start).getTime() <= currentTime()) e.start = "Start time must be in the future — or choose “Start immediately”.";
      if (start && end && new Date(end) <= new Date(start)) e.end = "End time must be after the start time.";
      else if (start && end && new Date(end).getTime() - new Date(start).getTime() < form.durationMinutes * 60000)
        e.end = `The window must be at least as long as the duration (${formatDuration(form.durationMinutes)}).`;
    }
    if (i === COMM_STEP) Object.assign(e, commErrors());
    return e;
  }

  function goTo(next: number) {
    if (next > step) {
      for (let i = step; i < next; i++) {
        const e = validate(i);
        if (Object.keys(e).length) {
          setErrors(e);
          setStep(i);
          toast.error("Please fix the highlighted fields");
          return;
        }
      }
    }
    setErrors({});
    setStep(next);
    setMaxReached((m) => Math.max(m, next));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function scheduleFromForm(): Assessment["schedule"] {
    if (sched.mode === "now") {
      const start = new Date();
      const end = new Date(start.getTime() + Math.max(form.durationMinutes + 30, 180) * 60000);
      return { ...form.schedule, mode: "now", start: start.toISOString(), end: end.toISOString() };
    }
    return {
      ...form.schedule,
      mode: "later",
      start: fromIstParts(sched.startDate, sched.startTime) ?? form.schedule.start,
      end: fromIstParts(sched.endDate, sched.endTime) ?? form.schedule.end,
    };
  }

  function saveDraft() {
    if (form.name.trim().length < 3) {
      setErrors({ name: "Give the draft a name before saving." });
      setStep(0);
      toast.error("Add a name to save this draft");
      return;
    }
    const keepStatus = editing && editing.status !== "Draft" ? editing.status : "Draft";
    saveAssessment({ ...form, schedule: scheduleFromForm(), status: keepStatus });
    setDirty(false);
    setSavedOnce(true);
    toast.success(keepStatus === "Draft" ? "Draft saved" : "Changes saved", `“${form.name}” is saved. You can come back to it from Assessments.`);
  }

  function publish() {
    const status = sched.mode === "now" ? "Active" : "Scheduled";
    const schedule = { ...scheduleFromForm(), notifyLearners: comm.assignment.enabled, sendReminder: comm.reminder.enabled };
    const saved: Assessment = { ...form, communication: comm, schedule, status };
    saveAssessment(saved);
    addCommHistory(historyEntries(saved));
    setDirty(false);
    if (enabledComms.length) toast.success("Assessment published. Communication workflow activated.", `${saved.name} · ${batch?.label} · ${formatDateTime(saved.schedule.start)} IST`);
    else toast.success("Assessment published.", "Communication is disabled for this assessment — no emails will be sent.");
    router.push(`/admin/assessments/${saved.id}`);
  }

  /** Mock log rows for the Communication History tab. Nothing is actually sent. */
  function historyEntries(a: Assessment): CommHistoryEntry[] {
    const nowIso = new Date().toISOString();
    const startMs = new Date(a.schedule.start).getTime();
    const when: Record<CommKey, { date: string; status: CommHistoryEntry["status"] } | null> = {
      assignment: { date: nowIso, status: "Sent" },
      reminder: { date: reminderAt(comm.reminder, a.schedule.start) ?? nowIso, status: "Scheduled" },
      startingSoon: { date: new Date(startMs - 3600000).toISOString(), status: "Scheduled" },
      rescheduled: null, // event-driven: only if the schedule changes later
      cancelled: null,
      resultPublished: { date: a.schedule.end, status: "Draft" },
    };
    return enabledComms.flatMap((k) => {
      const w = when[k];
      const c = contentFor(comm[k], state.templates);
      if (!w || !c) return [];
      return [
        {
          id: newId("h"),
          date: w.date,
          templateId: comm[k].templateId,
          communication: state.templates.find((t) => t.id === comm[k].templateId)?.name ?? COMM_META[k].label,
          assessmentId: a.id,
          assessmentName: a.name,
          batchName: batch?.label ?? "—",
          recipients,
          status: w.status,
          subject: resolveVariables(c.subject, emailValues),
        },
      ];
    });
  }

  function leave() {
    if (dirty) setConfirmLeave(true);
    else router.push("/admin/assessments");
  }

  const isScheduledEdit = editing?.status === "Scheduled";

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Assessments", href: "/admin/assessments" }, { label: editing ? "Edit assessment" : "Create assessment" }]}
        title={editing ? `Edit: ${editing.name}` : "Create Assessment"}
        description="Set up the assessment, choose a prepared question paper, configure it and schedule it for a batch."
        meta={editing ? <StatusBadge status={editing.status} /> : dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : savedOnce ? <span className="text-xs text-muted-foreground">Saved</span> : null}
      />

      <div className="mb-6 rounded-lg border bg-card px-4 py-3">
        <Stepper steps={STEPS} current={step} maxReached={maxReached} onStepClick={goTo} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="min-w-0">
          {step === 0 ? (
            <Panel title="Basic details" description="Who the assessment is for and the core rules.">
              <div className="grid gap-4">
                <Field label="Assessment name" htmlFor="name" required error={errors.name}>
                  <Input id="name" value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="e.g. Product Management – Mid Term 1" aria-invalid={!!errors.name || undefined} />
                </Field>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Course" htmlFor="course" required error={errors.courseId}>
                    <SelectField
                      id="course"
                      value={form.courseId}
                      onChange={(v) => update({ courseId: v, batchId: "", paperId: form.paperId && lookup.paper(form.paperId)?.courseId === v ? form.paperId : null })}
                      placeholder="Select a course"
                      options={state.courses.map((c) => ({ value: c.id, label: c.name }))}
                      invalid={!!errors.courseId}
                    />
                  </Field>
                  <Field label="Batch" htmlFor="batch" required error={errors.batchId} hint={form.courseId ? undefined : "Choose a course first"}>
                    <SelectField
                      id="batch"
                      value={form.batchId}
                      onChange={(v) => update({ batchId: v })}
                      placeholder="Select a batch"
                      disabled={!form.courseId}
                      options={state.batches
                        .filter((b) => b.courseId === form.courseId && b.status !== "Completed")
                        .map((b) => ({ value: b.id, label: `${b.label} · ${formatNumber(b.learnerIds.length)} learners` }))}
                      invalid={!!errors.batchId}
                    />
                  </Field>
                </div>
                <Field label="Assessment type">
                  <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Assessment type">
                    {(
                      [
                        ["Objective", "MCQ and true/false. Scored automatically."],
                        ["Subjective", "Written answers marked by examiners."],
                        ["Mixed", "Both objective and subjective sections."],
                      ] as [AssessmentType, string][]
                    ).map(([t, d]) => (
                      <button
                        key={t}
                        type="button"
                        role="radio"
                        aria-checked={form.type === t}
                        onClick={() => update({ type: t })}
                        className={cn("rounded-lg border p-3 text-left transition-colors", form.type === t ? "border-primary bg-accent/60 ring-1 ring-primary" : "hover:bg-muted/60")}
                      >
                        <span className="block text-sm font-medium">{t}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{d}</span>
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Description" htmlFor="desc" hint="Internal note for admins and examiners.">
                  <Textarea id="desc" rows={2} value={form.description} onChange={(e) => update({ description: e.target.value })} />
                </Field>
                <Field label="Instructions for learners" htmlFor="instr" hint="Shown before the learner starts. One instruction per line.">
                  <Textarea id="instr" rows={4} value={form.instructions} onChange={(e) => update({ instructions: e.target.value })} />
                </Field>
              </div>
            </Panel>
          ) : null}

          {step === 1 ? <PaperStep form={form} update={update} error={errors.paperId} /> : null}

          {step === 2 && paper && totals ? (
            <div className="grid gap-6">
              <Panel title="Question paper" description={`${paper.name} · ${paper.version}`} actions={<Button variant="ghost" size="sm" onClick={() => goTo(1)}>Change paper</Button>}>
                <PaperStructure paper={paper} />
              </Panel>
              <Panel title="Configuration" description="How the assessment runs for learners." bodyClassName="p-0">
                <ConfigGroup title="Assessment timing" description="Time allowed and what happens when the window closes.">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label="Duration (minutes)"
                      htmlFor="dur"
                      required
                      error={errors.durationMinutes}
                      hint={paper.durationMinutes !== form.durationMinutes ? `Paper suggests ${paper.durationMinutes} min` : "Matches the question paper"}
                    >
                      <Input id="dur" type="number" min={5} max={600} value={form.durationMinutes} onChange={(e) => update({ durationMinutes: Number(e.target.value) })} aria-invalid={!!errors.durationMinutes || undefined} />
                    </Field>
                    <Field label="Start / end behaviour" htmlFor="timing">
                      <SelectField
                        id="timing"
                        value={form.settings.timingMode}
                        onChange={(v) => updateSettings({ timingMode: v as TimingMode })}
                        options={[
                          { value: "window", label: "End all attempts when the window closes" },
                          { value: "full", label: "Full duration for anyone who starts in the window" },
                        ]}
                      />
                    </Field>
                  </div>
                </ConfigGroup>
                <ConfigGroup title="Attempts">
                  <Field label="Maximum attempts" htmlFor="att" error={errors.maxAttempts} hint="Default: 1" className="max-w-[12rem]">
                    <Input id="att" type="number" min={1} max={10} value={form.maxAttempts} onChange={(e) => update({ maxAttempts: Number(e.target.value) })} aria-invalid={!!errors.maxAttempts || undefined} />
                  </Field>
                </ConfigGroup>
                <ConfigGroup title="Scoring" description="Subjective answers are never penalised.">
                  <ToggleRow
                    label="Negative marking"
                    description="Deduct marks for incorrect objective answers."
                    checked={form.negativeMarking}
                    onChange={(v) => update({ negativeMarking: v, negativeMarks: v && !form.negativeMarks ? 0.25 : form.negativeMarks })}
                  />
                  {form.negativeMarking ? (
                    <Field label="Negative marks per wrong answer" htmlFor="neg" error={errors.negativeMarks} className="mt-3 max-w-[12rem]">
                      <Input id="neg" type="number" min={0} step={0.25} value={form.negativeMarks} onChange={(e) => update({ negativeMarks: Number(e.target.value) })} aria-invalid={!!errors.negativeMarks || undefined} />
                    </Field>
                  ) : null}
                </ConfigGroup>
                <ConfigGroup title="Question behaviour">
                  <div className="divide-y">
                    <ToggleRow label="Randomize questions" description="Shuffle question order within each section for every learner." checked={form.settings.randomizeQuestions} onChange={(v) => updateSettings({ randomizeQuestions: v })} />
                    <ToggleRow label="Randomize options" description="Shuffle MCQ options for every learner." checked={form.settings.randomizeOptions} onChange={(v) => updateSettings({ randomizeOptions: v })} />
                  </div>
                </ConfigGroup>
                <ConfigGroup title="Learner experience">
                  <div className="divide-y">
                    <ToggleRow label="Allow resume" description="Continue after a disconnect or refresh, within the time limit." checked={form.settings.allowResume} onChange={(v) => updateSettings({ allowResume: v })} />
                    <ToggleRow label="Show question palette" description="Learners see each question’s status and can jump between questions." checked={form.settings.showQuestionPalette} onChange={(v) => updateSettings({ showQuestionPalette: v })} />
                    <ToggleRow label="Allow mark for review" description="Learners can flag questions to revisit before submitting." checked={form.settings.allowMarkForReview} onChange={(v) => updateSettings({ allowMarkForReview: v })} />
                  </div>
                </ConfigGroup>
                <ConfigGroup title="Results">
                  <ToggleRow
                    label="Show result immediately"
                    description={totals.subjective > 0 ? "Only the objective score can be shown on submission; subjective marks follow evaluation." : "Learners see their score as soon as they submit."}
                    checked={form.settings.showResultsImmediately}
                    onChange={(v) => updateSettings({ showResultsImmediately: v })}
                  />
                  <Field label="Result visibility" htmlFor="rv" className="mt-3 max-w-md" hint="What learners can see once results are released.">
                    <SelectField
                      id="rv"
                      value={form.settings.resultVisibility}
                      onChange={(v) => updateSettings({ resultVisibility: v as ResultVisibility })}
                      options={(Object.keys(RESULT_VISIBILITY_LABEL) as ResultVisibility[]).map((k) => ({ value: k, label: RESULT_VISIBILITY_LABEL[k] }))}
                    />
                  </Field>
                </ConfigGroup>
                <ConfigGroup title="Security" last>
                  <ToggleRow label="Proctoring" description="Monitor learners through a third-party proctoring provider." checked={form.settings.proctoring} onChange={(v) => updateSettings({ proctoring: v })}>
                    {form.settings.proctoring ? (
                      <p className="mt-3 flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
                        <ShieldAlert className="size-4 shrink-0" aria-hidden /> Proctoring provider is not configured yet.
                      </p>
                    ) : null}
                  </ToggleRow>
                </ConfigGroup>
              </Panel>
            </div>
          ) : null}

          {(step === 2 || step === LAST) && !paper ? (
            <EmptyState
              icon={FileStack}
              title="Select a question paper first"
              description="Configuration and review depend on the paper’s sections and marks."
              action={<Button onClick={() => goTo(1)}>Select Question Paper</Button>}
            />
          ) : null}

          {step === 3 ? (
            <Panel title="Schedule" description="When learners in the batch can take the assessment.">
              <div className="grid gap-5">
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Schedule mode">
                  {(
                    [
                      ["later", "Schedule for later", "Pick a start and end time."],
                      ["now", "Start immediately", "Opens as soon as you publish."],
                    ] as const
                  ).map(([v, t, d]) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={sched.mode === v}
                      onClick={() => updateSched({ mode: v })}
                      className={cn("rounded-lg border p-3 text-left", sched.mode === v ? "border-primary bg-accent/60 ring-1 ring-primary" : "hover:bg-muted/60")}
                    >
                      <span className="block text-sm font-medium">{t}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{d}</span>
                    </button>
                  ))}
                </div>
                {sched.mode === "later" ? (
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Start date" htmlFor="sd" error={errors.start}>
                        <Input id="sd" type="date" value={sched.startDate} onChange={(e) => updateSched({ startDate: e.target.value })} aria-invalid={!!errors.start || undefined} />
                      </Field>
                      <Field label="Start time" htmlFor="st">
                        <Input id="st" type="time" value={sched.startTime} onChange={(e) => updateSched({ startTime: e.target.value })} />
                      </Field>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="End date" htmlFor="ed" error={errors.end}>
                        <Input id="ed" type="date" value={sched.endDate} onChange={(e) => updateSched({ endDate: e.target.value })} aria-invalid={!!errors.end || undefined} />
                      </Field>
                      <Field label="End time" htmlFor="et">
                        <Input id="et" type="time" value={sched.endTime} onChange={(e) => updateSched({ endTime: e.target.value })} />
                      </Field>
                    </div>
                  </div>
                ) : (
                  <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                    The assessment opens immediately after you publish and closes {formatDuration(Math.max(form.durationMinutes + 30, 180))} later.
                  </p>
                )}
                <Field label="Timezone">
                  <Input value="Asia/Kolkata (IST)" readOnly disabled />
                </Field>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3">
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Mail className="size-4 shrink-0" aria-hidden /> Assignment emails and reminders are set up in the next step, based on this schedule.
                  </p>
                  <Button variant="ghost" size="sm" onClick={() => goTo(COMM_STEP)}>
                    Configure communication
                  </Button>
                </div>
              </div>
            </Panel>
          ) : null}

          {step === COMM_STEP ? (
            <CommunicationStep
              form={form}
              comm={comm}
              setComm={setComm}
              setBatch={(batchId) => update({ batchId, communication: { ...comm, audience: "batch", selectedLearnerIds: [] } })}
              startIso={planned.start}
              endIso={planned.end}
              errors={commErrors()}
            />
          ) : null}

          {step === LAST && paper && totals ? (
            <div className="grid gap-4">
              <ReviewBlock title="Assessment details" onEdit={() => goTo(0)}>
                <DetailList
                  items={[
                    ["Name", form.name],
                    ["Type", form.type],
                    ["Course", course?.name],
                    ["Batch", `${batch?.name} · ${formatNumber(batch?.learnerIds.length ?? 0)} learners`],
                    ...(form.description ? ([["Description", form.description]] as [string, string][]) : []),
                    ["Instructions", <span key="i" className="whitespace-pre-line text-muted-foreground">{form.instructions || "—"}</span>],
                  ]}
                />
              </ReviewBlock>
              <ReviewBlock title="Question paper" onEdit={() => goTo(1)}>
                <p className="mb-3 text-sm">
                  <span className="font-medium">{paper.name}</span>{" "}
                  <span className="text-muted-foreground">
                    · {paper.version} · {totals.questions} questions · {totals.sections} sections · {totals.marks} marks
                  </span>
                </p>
                <PaperStructure paper={paper} />
              </ReviewBlock>
              <ReviewBlock title="Configuration" onEdit={() => goTo(2)}>
                <DetailList
                  items={[
                    ["Duration", `${formatDuration(form.durationMinutes)} · ${form.settings.timingMode === "window" ? "attempts end when the window closes" : "full duration if started within the window"}`],
                    ["Attempts", String(form.maxAttempts)],
                    ["Negative marking", form.negativeMarking ? `−${form.negativeMarks} per wrong objective answer` : "Off"],
                    ["Randomization", [form.settings.randomizeQuestions && "Questions", form.settings.randomizeOptions && "Options"].filter(Boolean).join(", ") || "Off"],
                    [
                      "Learner experience",
                      [form.settings.allowResume && "Resume", form.settings.showQuestionPalette && "Question palette", form.settings.allowMarkForReview && "Mark for review"].filter(Boolean).join(", ") || "Minimal",
                    ],
                    ["Results", `${form.settings.showResultsImmediately ? "Shown on submission" : "After publishing"} · ${RESULT_VISIBILITY_LABEL[form.settings.resultVisibility]}`],
                    ["Proctoring", form.settings.proctoring ? "On · provider not configured yet" : "Off"],
                  ]}
                />
              </ReviewBlock>
              <ReviewBlock title="Schedule" onEdit={() => goTo(3)}>
                <DetailList
                  items={[
                    ["Opens", sched.mode === "now" ? "Immediately on publish" : `${formatDateTime(fromIstParts(sched.startDate, sched.startTime))} IST`],
                    ["Closes", sched.mode === "now" ? `${formatDuration(Math.max(form.durationMinutes + 30, 180))} after opening` : `${formatDateTime(fromIstParts(sched.endDate, sched.endTime))} IST`],
                  ]}
                />
              </ReviewBlock>
              <ReviewBlock
                title="Communication"
                onEdit={() => goTo(COMM_STEP)}
                extra={
                  enabledComms.length ? (
                    <Button variant="outline" size="sm" onClick={() => setPreviewKey(enabledComms[0])}>
                      <Eye /> Preview Communication
                    </Button>
                  ) : null
                }
              >
                <CommSummaryList comm={comm} startIso={planned.start} recipientsText={`${formatNumber(recipients)} learners · ${batch?.label ?? "—"}`} />
              </ReviewBlock>
            </div>
          ) : null}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              <Button variant="ghost" onClick={leave}>
                Cancel
              </Button>
              {step > 0 ? (
                <Button variant="outline" onClick={() => goTo(step - 1)}>
                  Back
                </Button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={saveDraft}>
                {isScheduledEdit ? "Save changes" : "Save Draft"}
              </Button>
              {step < LAST ? (
                <Button onClick={() => goTo(step + 1)}>Next</Button>
              ) : (
                <Button
                  onClick={() => {
                    for (let i = 0; i < LAST; i++) {
                      const e = validate(i);
                      if (Object.keys(e).length) {
                        setErrors(e);
                        setStep(i);
                        toast.error("Something needs attention before publishing");
                        return;
                      }
                    }
                    setConfirmSchedule(true);
                  }}
                >
                  <Send /> {isScheduledEdit ? "Update Assessment" : "Publish Assessment"}
                </Button>
              )}
            </div>
          </div>
        </div>

        <aside className="hidden xl:block">
          <div className="sticky top-20 grid gap-4">
            <Panel title="Summary">
              <DetailList
                className="grid-cols-[5.5rem_1fr]"
                items={[
                  ["Name", form.name || <span className="text-muted-foreground">—</span>],
                  ["Batch", batch ? `${batch.label}` : <span className="text-muted-foreground">—</span>],
                  ["Paper", paper ? paper.name : <span className="text-muted-foreground">Not selected</span>],
                  ["Marks", totals ? totals.marks : "—"],
                  ["Duration", formatDuration(form.durationMinutes)],
                  ["Type", form.type],
                ]}
              />
            </Panel>
            <p className="px-1 text-xs text-muted-foreground">Prototype: saving updates in-memory mock data only.</p>
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmSchedule}
        onOpenChange={setConfirmSchedule}
        title={isScheduledEdit ? "Update Assessment?" : "Publish Assessment?"}
        description={sched.mode === "now" ? "The assessment opens as soon as you publish. Review the summary below." : "Learners are assigned when you publish. Review the summary below."}
        confirmLabel={isScheduledEdit ? "Update Assessment" : "Publish Assessment"}
        onConfirm={publish}
      >
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 rounded-lg border px-3 py-3 text-sm">
          <dt className="text-muted-foreground">Assessment</dt>
          <dd>
            <span className="font-medium">{form.name}</span>
            <span className="block text-xs text-muted-foreground">
              {paper?.name} · {totals?.marks} marks · {formatDuration(form.durationMinutes)} · {form.maxAttempts} attempt{form.maxAttempts === 1 ? "" : "s"}
            </span>
          </dd>
          <dt className="text-muted-foreground">Batch</dt>
          <dd>
            {batch?.name}
            <span className="block text-xs text-muted-foreground">
              {formatNumber(recipients)} recipients{comm.audience === "selected" ? " (selected learners)" : ""}
            </span>
          </dd>
          <dt className="text-muted-foreground">Schedule</dt>
          <dd>
            {sched.mode === "now" ? "Opens immediately" : `${formatDateTime(planned.start)} IST`}
            <span className="block text-xs text-muted-foreground">Closes {formatDateTime(planned.end)} IST</span>
          </dd>
          <dt className="text-muted-foreground">Communication</dt>
          <dd>
            {enabledComms.length ? (
              <ul className="grid gap-1">
                {enabledComms.map((k) => (
                  <li key={k} className="flex items-start gap-1.5">
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden />
                    <span>
                      {COMM_META[k].label} <span className="text-xs text-muted-foreground">· {timingFor(k, comm, planned.start)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground">Communication is disabled for this assessment.</span>
            )}
          </dd>
        </dl>
        <p className="text-xs text-muted-foreground">Prototype: no emails are actually sent.</p>
      </ConfirmDialog>

      <EmailPreviewDialog
        email={previewKey ? contentFor(comm[previewKey], state.templates) : null}
        values={emailValues}
        to={`${firstLearner?.email ?? emailValues.learner_email}${recipients > 1 ? ` and ${formatNumber(recipients - 1)} other learners` : ""}`}
        onClose={() => setPreviewKey(null)}
        title="Preview Communication"
        context={
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Communication">
            {enabledComms.map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={previewKey === k}
                onClick={() => setPreviewKey(k)}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium", previewKey === k ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground")}
              >
                {COMM_META[k].label}
              </button>
            ))}
            {previewKey ? <span className="ml-auto self-center text-xs text-muted-foreground">{timingFor(previewKey, comm, planned.start)}</span> : null}
          </div>
        }
      />

      <ConfirmDialog
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title="Discard unsaved changes?"
        description="You have changes that haven’t been saved. Save a draft to keep them."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          setDirty(false);
          router.push("/admin/assessments");
        }}
      />
    </>
  );
}

function ConfigGroup({ title, description, children, last }: { title: string; description?: string; children: React.ReactNode; last?: boolean }) {
  return (
    <section className={cn("grid gap-3 px-4 py-4 md:grid-cols-[14rem_1fr] md:gap-6", !last && "border-b")}>
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function ReviewBlock({ title, onEdit, extra, children }: { title: string; onEdit: () => void; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Panel
      title={title}
      actions={
        <>
          {extra}
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil /> Edit
          </Button>
        </>
      }
    >
      {children}
    </Panel>
  );
}

function CommSummaryList({ comm, startIso, recipientsText }: { comm: AssessmentCommunication; startIso: string; recipientsText: string }) {
  const state = useProto();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Communication</th>
            <th className="py-2 pr-3 font-medium">Template</th>
            <th className="py-2 pr-3 font-medium">Recipients</th>
            <th className="py-2 font-medium">Timing</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {COMM_ORDER.map((k) => {
            const on = comm[k].enabled;
            const t = state.templates.find((x) => x.id === comm[k].templateId);
            return (
              <tr key={k} className={cn(!on && "text-muted-foreground")}>
                <td className="py-2 pr-3">
                  <span className="flex items-center gap-1.5">
                    {on ? <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden /> : <Circle className="size-3.5" aria-hidden />}
                    <span className={cn(on && "font-medium")}>{COMM_META[k].label}</span>
                    <span className="sr-only">{on ? "enabled" : "disabled"}</span>
                  </span>
                </td>
                <td className="py-2 pr-3">
                  {on ? (
                    <>
                      {t?.name ?? "—"}
                      {comm[k].override ? <span className="ml-1 text-xs text-muted-foreground">(customised)</span> : null}
                    </>
                  ) : (
                    "Off"
                  )}
                </td>
                <td className="py-2 pr-3">{on ? recipientsText : "—"}</td>
                <td className="py-2">{on ? timingFor(k, comm, startIso) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PaperStep({ form, update, error }: { form: Assessment; update: (p: Partial<Assessment>) => void; error?: string }) {
  const state = useProto();
  const lookup = useLookups();
  const [q, setQ] = useState("");
  const [course, setCourse] = useState(form.courseId);
  const [subject, setSubject] = useState("");
  const [batch, setBatch] = useState("");
  const [status, setStatus] = useState("Approved");
  const [changing, setChanging] = useState(!form.paperId);

  const subjects = useMemo(() => [...new Set(state.papers.map((p) => p.subject))].sort(), [state.papers]);
  const rows = state.papers
    .filter((p) => p.status !== "Archived")
    .filter((p) => (course ? p.courseId === course : true))
    .filter((p) => (subject ? p.subject === subject : true))
    .filter((p) => (batch ? p.batchId === batch : true))
    .filter((p) => (status ? p.status === status : true))
    .filter((p) => (q.trim() ? p.name.toLowerCase().includes(q.trim().toLowerCase()) : true));

  const selected = lookup.paper(form.paperId);

  if (selected && !changing) {
    const t = paperTotals(selected);
    return (
      <Panel title="Selected question paper">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-base font-semibold">{selected.name}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {lookup.course(selected.courseId)?.name} · {selected.subject} · {selected.version} · imported {formatDate(selected.importedOn)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={selected.status} />
            <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
              Change
            </Button>
          </div>
        </div>
        <div className="mt-4">
          <PaperStats paper={selected} />
        </div>
        <PaperStructure paper={selected} className="mt-4" />
        {selected.courseId !== form.courseId ? (
          <p className="mt-3 text-xs text-amber-700">This paper belongs to a different course than the assessment.</p>
        ) : null}
        {(t.subjective > 0 && form.type === "Objective") || (t.objective > 0 && form.type === "Subjective") ? (
          <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-amber-700">
            This paper has {t.objective} objective and {t.subjective} subjective questions, but the assessment type is {form.type}.
            <button type="button" className="font-medium underline" onClick={() => update({ type: t.subjective === 0 ? "Objective" : t.objective === 0 ? "Subjective" : "Mixed" })}>
              Match the paper
            </button>
          </p>
        ) : null}
      </Panel>
    );
  }

  return (
    <Panel title="Select Question Paper" description="Choose a prepared, approved question paper. Individual questions are managed inside the paper.">
      {error ? <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-destructive ring-1 ring-red-200 ring-inset">{error}</p> : null}
      <div className="mb-4 grid gap-2 md:grid-cols-[1fr_repeat(4,minmax(0,9.5rem))]">
        <SearchInput value={q} onChange={setQ} placeholder="Search question papers…" />
        <SelectField value={course} onChange={setCourse} placeholder="All courses" ariaLabel="Course" options={state.courses.map((c) => ({ value: c.id, label: c.name }))} />
        <SelectField value={subject} onChange={setSubject} placeholder="All subjects" ariaLabel="Subject" options={subjects.map((s) => ({ value: s, label: s }))} />
        <SelectField value={batch} onChange={setBatch} placeholder="All batches" ariaLabel="Batch" options={state.batches.map((b) => ({ value: b.id, label: b.label }))} />
        <SelectField value={status} onChange={setStatus} placeholder="Any status" ariaLabel="Status" options={["Approved", "Needs Review", "Draft", "Processing"].map((s) => ({ value: s, label: s }))} />
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={FileStack} title="No question papers match" description="Adjust the filters, or import a new question paper." />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {rows.map((p) => {
            const t = paperTotals(p);
            const selectable = p.status === "Approved";
            const isSelected = form.paperId === p.id;
            return (
              <li key={p.id} className={cn("flex flex-col rounded-lg border bg-background p-4", isSelected && "border-primary ring-1 ring-primary")}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold">{p.name}</p>
                  <StatusBadge status={p.status} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {lookup.course(p.courseId)?.name} · {p.subject} · {lookup.batch(p.batchId)?.label}
                </p>
                <dl className="mt-3 grid grid-cols-4 gap-2 text-xs">
                  {[
                    [t.questions, "Questions"],
                    [t.sections, "Sections"],
                    [t.marks, "Marks"],
                    [p.version, "Version"],
                  ].map(([v, l]) => (
                    <div key={String(l)}>
                      <dt className="text-muted-foreground">{l}</dt>
                      <dd className="font-medium tabular-nums">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
                  <span className="text-xs text-muted-foreground">Imported {formatDate(p.importedOn)}</span>
                  <Button
                    size="sm"
                    variant={isSelected ? "secondary" : "default"}
                    disabled={!selectable}
                    title={selectable ? undefined : "Only approved papers can be used"}
                    onClick={() => {
                      update({ paperId: p.id, durationMinutes: p.durationMinutes });
                      setChanging(false);
                    }}
                  >
                    {isSelected ? "Selected" : selectable ? "Select" : "Needs approval"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export default withSuspense(CreateAssessmentWizard);
