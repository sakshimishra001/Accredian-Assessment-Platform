"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, FileStack, Info, Mail, Pencil, Send } from "lucide-react";
import { cn } from "cn";
import { ConfirmDialog, Field, SearchInput, SelectField, Stepper, ToggleRow } from "@/components/proto/controls";
import { DetailList, EmptyState, PageHeader, Panel } from "@/components/proto/page";
import { PaperStats, PaperStructure } from "@/components/proto/paper-summary";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { STATUS_LABEL, type AssessmentField } from "@/lib/assessments/lifecycle";
import { proctoringSummary } from "@/lib/proctoring/summary";
import { toIstInput } from "@/lib/datetime";
import { ASSESSMENT_TYPE_LABEL, MAX_ATTEMPTS_LIMIT, MAX_DURATION_MINUTES, RESULT_VISIBILITY_LABEL } from "@/lib/validation/assessment";
import { formatDate, formatDateTime, formatDuration, formatNumber } from "@/prototype/lib/format";
import type { QuestionPaper } from "@/prototype/types";
import { useToast } from "@/prototype/toast";
import { publishAssessmentAction, saveAssessmentAction } from "@/server/actions/assessments";
import { saveAssessmentCommunicationAction } from "@/server/actions/communication";
import { COMMUNICATION_EVENTS, type CommunicationEventKey } from "@/lib/communication/templates";
import { CommunicationSettings, toCommunicationPayload, toCommunicationState, type CommunicationData, type CommunicationState, type EventState } from "./communication-settings";
import type { AssessmentDetail } from "@/server/services/assessments";

const STEPS = ["Basic details", "Question paper", "Configuration", "Schedule", "Communication", "Review & publish"];
const LAST = STEPS.length - 1;
export type WizardStep = 0 | 1 | 2 | 3 | 4 | 5;

type AssessmentType = AssessmentDetail["type"];
type FieldErrors = Record<string, string[] | undefined>;

const RESULT_DETAIL_LABEL: Record<AssessmentDetail["resultDetail"], string> = {
  SCORE: "Score only",
  SCORE_AND_ANSWERS: "Score and their answers",
  FULL_FEEDBACK: "Score, answers and examiner feedback",
};
const TYPE_HINT: Record<AssessmentType, string> = {
  OBJECTIVE: "MCQ and true/false. Scored automatically.",
  SUBJECTIVE: "Written answers marked by examiners.",
  MIXED: "Both objective and subjective sections.",
};

/** The step where each server field is entered, so a server error takes the admin there. */
const FIELD_STEP: Record<string, number> = {
  name: 0,
  batchId: 0,
  type: 0,
  description: 0,
  instructions: 0,
  paperId: 1,
  durationMinutes: 2,
  timingMode: 2,
  maxAttempts: 2,
  passingMarks: 2,
  negativeMarking: 2,
  randomizeQuestions: 2,
  randomizeOptions: 2,
  allowResume: 2,
  showQuestionPalette: 2,
  allowMarkForReview: 2,
  calculatorEnabled: 2,
  calculatorType: 2,
  spellCheckEnabled: 2,
  focusMonitoringEnabled: 2,
  focusMaxViolations: 2,
  focusViolationAction: 2,
  fullscreenEnabled: 2,
  clipboardMonitoringEnabled: 2,
  cameraRequired: 2,
  faceDetectionEnabled: 2,
  multipleFaceDetectionEnabled: 2,
  faceMissingDetectionEnabled: 2,
  cameraSnapshotsEnabled: 2,
  screenMonitoringEnabled: 2,
  resultVisibility: 2,
  resultDetail: 2,
  proctoringEnabled: 2,
  startAt: 3,
  endAt: 3,
};

export interface BatchOption {
  id: string;
  name: string;
  code: string | null;
  /** Shown to tell batches of the same name apart; the assessment takes its course from the batch. */
  courseName: string;
  learnerCount: number;
}
export interface PaperOption {
  id: string;
  name: string;
  subject: string | null;
  version: number;
  courseId: string;
  courseName: string;
  durationMinutes: number | null;
  questionCount: number;
  sectionCount: number;
  totalMarks: number;
  updatedAt: Date;
}

interface Form {
  name: string;
  batchId: string;
  type: AssessmentType;
  description: string;
  instructions: string;
  durationMinutes: string;
  timingMode: AssessmentDetail["settings"]["timingMode"];
  maxAttempts: string;
  passingMarks: string;
  negativeMarking: boolean;
  randomizeQuestions: boolean;
  randomizeOptions: boolean;
  allowResume: boolean;
  showQuestionPalette: boolean;
  allowMarkForReview: boolean;
  calculatorEnabled: boolean;
  calculatorType: AssessmentDetail["settings"]["calculatorType"];
  spellCheckEnabled: boolean;
  focusMonitoringEnabled: boolean;
  focusMaxViolations: string;
  focusViolationAction: AssessmentDetail["settings"]["focusViolationAction"];
  fullscreenEnabled: boolean;
  clipboardMonitoringEnabled: boolean;
  cameraRequired: boolean;
  faceDetectionEnabled: boolean;
  multipleFaceDetectionEnabled: boolean;
  faceMissingDetectionEnabled: boolean;
  cameraSnapshotsEnabled: boolean;
  screenMonitoringEnabled: boolean;
  resultVisibility: AssessmentDetail["resultVisibility"];
  resultDetail: AssessmentDetail["resultDetail"];
  proctoringEnabled: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

const DEFAULT_INSTRUCTIONS = "Read every question carefully before answering.\nThe timer starts when you begin and cannot be paused.\nAnswers are saved automatically.";

function initialForm(a: AssessmentDetail | null, defaults: { startAt: string; endAt: string }): Form {
  const [startDate, startTime] = (a ? toIstInput(a.startAt) : defaults.startAt).split("T");
  const [endDate, endTime] = (a ? toIstInput(a.endAt) : defaults.endAt).split("T");
  const window = { startDate, startTime, endDate, endTime };
  if (!a) {
    return {
      name: "",
      batchId: "",
      type: "MIXED",
      description: "",
      instructions: DEFAULT_INSTRUCTIONS,
      durationMinutes: "60",
      timingMode: "WINDOW",
      maxAttempts: "1",
      passingMarks: "0",
      negativeMarking: true,
      randomizeQuestions: false,
      randomizeOptions: false,
      allowResume: true,
      showQuestionPalette: true,
      allowMarkForReview: true,
      calculatorEnabled: false,
      calculatorType: "BASIC",
      spellCheckEnabled: false,
      focusMonitoringEnabled: false,
      focusMaxViolations: "3",
      focusViolationAction: "TERMINATE",
      fullscreenEnabled: false,
      clipboardMonitoringEnabled: false,
      cameraRequired: false,
      faceDetectionEnabled: false,
      multipleFaceDetectionEnabled: false,
      faceMissingDetectionEnabled: false,
      cameraSnapshotsEnabled: false,
      screenMonitoringEnabled: false,
      resultVisibility: "ON_PUBLISH",
      resultDetail: "SCORE",
      proctoringEnabled: false,
      ...window,
    };
  }
  return {
    name: a.name,
    batchId: a.batch?.id ?? "",
    type: a.type,
    description: a.description ?? "",
    instructions: a.instructions ?? "",
    durationMinutes: String(a.durationMinutes),
    timingMode: a.settings.timingMode,
    maxAttempts: String(a.maxAttempts),
    passingMarks: String(a.passingMarks),
    negativeMarking: a.settings.negativeMarking,
    randomizeQuestions: a.settings.randomizeQuestions,
    randomizeOptions: a.settings.randomizeOptions,
    allowResume: a.settings.allowResume,
    showQuestionPalette: a.settings.showQuestionPalette,
    allowMarkForReview: a.settings.allowMarkForReview,
    calculatorEnabled: a.settings.calculatorEnabled,
    calculatorType: a.settings.calculatorType,
    spellCheckEnabled: a.settings.spellCheckEnabled,
    focusMonitoringEnabled: a.settings.focusMonitoringEnabled,
    focusMaxViolations: String(a.settings.focusMaxViolations),
    focusViolationAction: a.settings.focusViolationAction,
    fullscreenEnabled: a.settings.fullscreenEnabled,
    clipboardMonitoringEnabled: a.settings.clipboardMonitoringEnabled,
    cameraRequired: a.settings.cameraRequired,
    faceDetectionEnabled: a.settings.faceDetectionEnabled,
    multipleFaceDetectionEnabled: a.settings.multipleFaceDetectionEnabled,
    faceMissingDetectionEnabled: a.settings.faceMissingDetectionEnabled,
    cameraSnapshotsEnabled: a.settings.cameraSnapshotsEnabled,
    screenMonitoringEnabled: a.settings.screenMonitoringEnabled,
    resultVisibility: a.resultVisibility,
    resultDetail: a.resultDetail,
    proctoringEnabled: a.proctoringEnabled,
    ...window,
  };
}

/** What the wizard sends to the assessment service (the service validates everything). */
function toPayload(f: Form) {
  const { startDate, startTime, endDate, endTime, ...rest } = f;
  return { ...rest, startAt: `${startDate}T${startTime}`, endAt: `${endDate}T${endTime}` };
}

const COMM_STEP = 4;
const isCommField = (k: string) => COMMUNICATION_EVENTS.some((e) => k.startsWith(`${e.key}.`));

/** Which step holds the first server error. */
function firstErrorStep(errors: FieldErrors) {
  const steps = Object.keys(errors).map((k) => (isCommField(k) ? COMM_STEP : (FIELD_STEP[k] ?? 0)));
  return steps.length ? Math.min(...steps) : null;
}

export function AssessmentWizard({
  assessment,
  paper,
  communication,
  batches,
  papers,
  defaults,
  initialStep,
}: {
  assessment: AssessmentDetail | null;
  /** The selected question paper, for display. */
  paper: QuestionPaper | null;
  /** Saved communication settings and selectable templates (once the draft exists). */
  communication: CommunicationData | null;
  batches: BatchOption[];
  papers: PaperOption[];
  defaults: { startAt: string; endAt: string };
  initialStep: WizardStep;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<Form>(() => initialForm(assessment, defaults));
  const [step, setStep] = useState(() => (assessment ? Math.min(LAST, Math.max(0, initialStep || 0)) : 0));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [dirty, setDirty] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [comm, setComm] = useState<CommunicationState | null>(() => (communication ? toCommunicationState(communication) : null));
  const [commDirty, setCommDirty] = useState(false);
  const updateComm = (key: CommunicationEventKey, patch: Partial<EventState>) => {
    setComm((c) => (c ? { ...c, [key]: { ...c[key], ...patch } } : c));
    setCommDirty(true);
    setDirty(true);
  };

  const id = assessment?.id ?? null;
  const isScheduled = assessment?.status === "SCHEDULED";
  const locked = (f: AssessmentField) => !!assessment && !assessment.editableFields.includes(f);
  const batch = batches.find((b) => b.id === form.batchId);
  const paperOption = assessment?.paper ? papers.find((p) => p.id === assessment.paper!.id) : undefined;
  const err = (f: string) => errors[f]?.[0];

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const update = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };

  /** Light checks before the first save; every real rule is enforced by the server. */
  function clientCheck(): FieldErrors {
    const e: FieldErrors = {};
    if (form.name.trim().length < 3) e.name = ["Enter an assessment name (at least 3 characters)."];
    if (!form.batchId) e.batchId = ["Choose the batch that will take this assessment."];
    return e;
  }

  /** Save the draft (create on first save). Resolves to the assessment id, or null on failure. */
  async function persist(extra: Record<string, unknown> = {}): Promise<string | null> {
    const e = clientCheck();
    if (Object.keys(e).length) {
      setErrors(e);
      setStep(0);
      toast.error("Please fix the highlighted fields");
      return null;
    }
    const payload: Record<string, unknown> = { ...toPayload(form), ...extra };
    // Only send fields the current status allows changing; locked ones stay as stored.
    if (assessment) for (const k of Object.keys(payload)) if (k in FIELD_STEP && locked(k as AssessmentField)) delete payload[k];

    const result = await saveAssessmentAction(id, payload);
    if (!result.ok) {
      const fe = result.fieldErrors ?? {};
      setErrors(fe);
      const at = firstErrorStep(fe);
      if (at !== null) setStep(at);
      toast.error(result.fieldErrors ? "Please fix the highlighted fields" : "Couldn’t save the assessment", result.fieldErrors ? undefined : result.error);
      return null;
    }
    if (commDirty && comm) {
      const saved = await saveAssessmentCommunicationAction(result.data!.id, toCommunicationPayload(comm));
      if (!saved.ok) {
        setErrors(saved.fieldErrors ?? {});
        setStep(COMM_STEP);
        toast.error("Communication settings not saved", saved.fieldErrors ? "Please fix the highlighted fields." : saved.error);
        return null;
      }
      setCommDirty(false);
    }
    setErrors({});
    setDirty(false);
    return result.data!.id;
  }

  function goTo(next: number) {
    if (next === step) return;
    if (next < step && id && !dirty) {
      setStep(next);
      return;
    }
    startTransition(async () => {
      const saved = id && !dirty ? id : await persist();
      if (!saved) return;
      if (!id) {
        // First save: continue on the stored draft (its URL survives a refresh).
        router.replace(`/admin/assessments/new?edit=${saved}&step=${next}`, { scroll: false });
        return;
      }
      setStep(next);
      router.replace(`/admin/assessments/new?edit=${saved}&step=${next}`, { scroll: false });
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function saveDraft() {
    startTransition(async () => {
      const saved = await persist();
      if (!saved) return;
      toast.success(isScheduled ? "Changes saved" : "Draft saved", `“${form.name}” is saved. You can come back to it from Assessments.`);
      if (!id) router.replace(`/admin/assessments/new?edit=${saved}&step=${step}`, { scroll: false });
    });
  }

  function selectPaper(p: PaperOption) {
    startTransition(async () => {
      const saved = await persist({ paperId: p.id });
      if (saved) toast.success("Question paper selected", `${p.name} · v${p.version}. Its questions are copied into the assessment.`);
    });
  }

  function matchPaperType(type: AssessmentType) {
    startTransition(async () => {
      const result = await saveAssessmentAction(id, { type });
      if (!result.ok) return toast.error("Couldn’t change the type", result.error);
      setForm((f) => ({ ...f, type }));
      toast.success(`Assessment type set to ${ASSESSMENT_TYPE_LABEL[type]}`);
    });
  }

  function publish() {
    startTransition(async () => {
      const saved = dirty ? await persist() : id;
      if (!saved) return;
      if (isScheduled) {
        toast.success("Changes saved");
        router.push(`/admin/assessments/${saved}`);
        return;
      }
      const result = await publishAssessmentAction(saved);
      if (!result.ok) return toast.error("This assessment can’t be published yet", result.error);
      toast.success("Assessment published", `${formatNumber(result.data!.candidatesAdded)} learner${result.data!.candidatesAdded === 1 ? "" : "s"} assigned · opens ${formatDateTime(`${form.startDate}T${form.startTime}:00+05:30`)} IST`);
      router.push(`/admin/assessments/${saved}`);
    });
  }

  const totals = assessment?.totals;
  const paperTypeHint = (() => {
    if (!assessment?.paper || !totals || totals.questionCount === 0) return null;
    const best: AssessmentType = totals.subjectiveCount === 0 ? "OBJECTIVE" : totals.objectiveCount === 0 ? "SUBJECTIVE" : "MIXED";
    return best === form.type ? null : best;
  })();
  const publishIssues = assessment?.status === "DRAFT" ? assessment.publishIssues : [];
  const reviewReady = !!assessment && !dirty && publishIssues.length === 0;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Assessments", href: "/admin/assessments" }, { label: assessment ? "Edit assessment" : "Create assessment" }]}
        title={assessment ? `Edit: ${assessment.name}` : "Create Assessment"}
        description="Set up the assessment, choose a question paper, configure it and schedule it for a batch."
        meta={
          assessment ? (
            <span className="flex items-center gap-2">
              <StatusBadge status={STATUS_LABEL[assessment.status]} />
              <span className="text-xs text-muted-foreground">{dirty ? "Unsaved changes" : "Saved"}</span>
            </span>
          ) : dirty ? (
            <span className="text-xs text-muted-foreground">Not saved yet</span>
          ) : null
        }
      />

      {isScheduled ? (
        <p className="mb-4 flex items-start gap-2 rounded-lg bg-accent px-4 py-3 text-sm text-accent-foreground">
          <Info className="mt-0.5 size-4 shrink-0" /> This assessment is scheduled: the paper, batch and rules are locked. You can still change the name, description, instructions and the schedule window.
        </p>
      ) : null}

      <div className="mb-6 rounded-lg border bg-card px-4 py-3">
        <Stepper steps={STEPS} current={step} maxReached={assessment ? LAST : step} onStepClick={goTo} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="min-w-0">
          {step === 0 ? (
            <Panel title="Basic details" description="Who the assessment is for and what it is.">
              <div className="grid gap-4">
                <Field label="Assessment name" htmlFor="name" required error={err("name")}>
                  <Input id="name" value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="e.g. Product Management – Mid Term 1" aria-invalid={!!err("name") || undefined} />
                </Field>
                <Field label="Batch" htmlFor="batch" required error={err("batchId")} hint={locked("batchId") ? "Locked once scheduled." : "Its active learners become the candidates when you publish."}>
                  <SelectField
                    id="batch"
                    value={form.batchId}
                    onChange={(v) => update({ batchId: v })}
                    placeholder="Select a batch"
                    disabled={locked("batchId")}
                    options={[
                      ...batches.map((b) => ({ value: b.id, label: `${b.name} · ${b.courseName} · ${formatNumber(b.learnerCount)} learners` })),
                      // A deactivated batch stays visible on an existing assessment (publishing will flag it).
                      ...(assessment?.batch && !batches.some((b) => b.id === assessment.batch!.id) ? [{ value: assessment.batch.id, label: `${assessment.batch.name} (inactive)` }] : []),
                    ]}
                    invalid={!!err("batchId")}
                  />
                </Field>
                <Field label="Assessment type" error={err("type")}>
                  <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Assessment type">
                    {(Object.keys(ASSESSMENT_TYPE_LABEL) as AssessmentType[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        role="radio"
                        aria-checked={form.type === t}
                        disabled={locked("type")}
                        onClick={() => update({ type: t, resultVisibility: t === "OBJECTIVE" ? form.resultVisibility : "ON_PUBLISH" })}
                        className={cn("rounded-lg border p-3 text-left transition-colors disabled:opacity-60", form.type === t ? "border-primary bg-accent/60 ring-1 ring-primary" : "hover:bg-muted/60")}
                      >
                        <span className="block text-sm font-medium">{ASSESSMENT_TYPE_LABEL[t]}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{TYPE_HINT[t]}</span>
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Description" htmlFor="desc" hint="Internal note for admins and examiners." error={err("description")}>
                  <Textarea id="desc" rows={2} value={form.description} onChange={(e) => update({ description: e.target.value })} />
                </Field>
                <Field label="Instructions for learners" htmlFor="instr" hint="Shown before the learner starts. One instruction per line." error={err("instructions")}>
                  <Textarea id="instr" rows={4} value={form.instructions} onChange={(e) => update({ instructions: e.target.value })} />
                </Field>
              </div>
            </Panel>
          ) : null}

          {step === 1 ? (
            <PaperStep
              papers={papers}
              selected={assessment?.paper ?? null}
              selectedView={paper}
              locked={locked("paperId")}
              pending={pending}
              error={err("paperId")}
              onSelect={selectPaper}
              typeHint={paperTypeHint}
              type={form.type}
              totals={totals}
              onMatchType={matchPaperType}
            />
          ) : null}

          {step === 2 ? (
            <div className="grid gap-6">
              {paper ? (
                <Panel title="Question paper" description={`${paper.name} · ${paper.version}`} actions={<Button variant="ghost" size="sm" onClick={() => goTo(1)}>Change paper</Button>}>
                  <PaperStructure paper={paper} />
                </Panel>
              ) : null}
              <Panel title="Configuration" description="How the assessment runs for learners." bodyClassName="p-0">
                <ConfigGroup title="Assessment timing" description="Time allowed and what happens when the window closes.">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label="Duration (minutes)"
                      htmlFor="dur"
                      required
                      error={err("durationMinutes")}
                      hint={paperOption?.durationMinutes && String(paperOption.durationMinutes) !== form.durationMinutes ? `Paper suggests ${paperOption.durationMinutes} min` : undefined}
                    >
                      <Input id="dur" type="number" min={1} max={MAX_DURATION_MINUTES} value={form.durationMinutes} disabled={locked("durationMinutes")} onChange={(e) => update({ durationMinutes: e.target.value })} aria-invalid={!!err("durationMinutes") || undefined} />
                    </Field>
                    <Field label="Start / end behaviour" htmlFor="timing" error={err("timingMode")}>
                      <SelectField
                        id="timing"
                        value={form.timingMode}
                        disabled={locked("timingMode")}
                        onChange={(v) => update({ timingMode: v as Form["timingMode"] })}
                        options={[
                          { value: "WINDOW", label: "End all attempts when the window closes" },
                          { value: "FULL_DURATION", label: "Full duration for anyone who starts in the window" },
                        ]}
                      />
                    </Field>
                  </div>
                  {paperOption?.durationMinutes && String(paperOption.durationMinutes) !== form.durationMinutes && !locked("durationMinutes") ? (
                    <Button variant="ghost" size="sm" className="mt-2" onClick={() => update({ durationMinutes: String(paperOption.durationMinutes) })}>
                      Use the paper’s {paperOption.durationMinutes} minutes
                    </Button>
                  ) : null}
                </ConfigGroup>
                <ConfigGroup title="Attempts & passing">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Maximum attempts" htmlFor="att" error={err("maxAttempts")} hint="Default: 1">
                      <Input id="att" type="number" min={1} max={MAX_ATTEMPTS_LIMIT} value={form.maxAttempts} disabled={locked("maxAttempts")} onChange={(e) => update({ maxAttempts: e.target.value })} aria-invalid={!!err("maxAttempts") || undefined} />
                    </Field>
                    <Field label="Passing marks" htmlFor="pass" error={err("passingMarks")} hint={totals ? `Out of ${totals.totalMarks} marks` : undefined}>
                      <Input id="pass" type="number" min={0} step={0.5} value={form.passingMarks} disabled={locked("passingMarks")} onChange={(e) => update({ passingMarks: e.target.value })} aria-invalid={!!err("passingMarks") || undefined} />
                    </Field>
                  </div>
                </ConfigGroup>
                <ConfigGroup title="Scoring" description="Subjective answers are never penalised.">
                  <ToggleRow
                    label="Negative marking"
                    description="Deduct the negative marks set on the paper’s objective questions for wrong answers."
                    checked={form.negativeMarking}
                    disabled={locked("negativeMarking")}
                    onChange={(v) => update({ negativeMarking: v })}
                  />
                </ConfigGroup>
                <ConfigGroup title="Question behaviour">
                  <div className="divide-y">
                    <ToggleRow label="Randomize questions" description="Shuffle question order within each section for every learner." checked={form.randomizeQuestions} disabled={locked("randomizeQuestions")} onChange={(v) => update({ randomizeQuestions: v })} />
                    <ToggleRow label="Randomize options" description="Shuffle MCQ options for every learner." checked={form.randomizeOptions} disabled={locked("randomizeOptions")} onChange={(v) => update({ randomizeOptions: v })} />
                  </div>
                </ConfigGroup>
                <ConfigGroup title="Learner experience">
                  <div className="divide-y">
                    <ToggleRow label="Allow resume" description="Continue after a disconnect or refresh, within the time limit." checked={form.allowResume} disabled={locked("allowResume")} onChange={(v) => update({ allowResume: v })} />
                    <ToggleRow label="Show question palette" description="Learners see each question’s status and can jump between questions." checked={form.showQuestionPalette} disabled={locked("showQuestionPalette")} onChange={(v) => update({ showQuestionPalette: v })} />
                    <ToggleRow label="Allow mark for review" description="Learners can flag questions to revisit before submitting." checked={form.allowMarkForReview} disabled={locked("allowMarkForReview")} onChange={(v) => update({ allowMarkForReview: v })} />
                  </div>
                </ConfigGroup>
                <ConfigGroup title="Learner tools" description="Tools learners can open during the exam. Nothing they do in them is saved.">
                  <ToggleRow
                    label="Calculator"
                    description="An on-screen calculator learners can open from the exam screen. It doesn’t pause or change the timer."
                    checked={form.calculatorEnabled}
                    disabled={locked("calculatorEnabled")}
                    onChange={(v) => update({ calculatorEnabled: v })}
                  />
                  {form.calculatorEnabled ? (
                    <fieldset className="mt-3 grid gap-2 text-sm" disabled={locked("calculatorType")}>
                      <legend className="mb-1 font-medium">Calculator type</legend>
                      {(
                        [
                          ["BASIC", "Basic", "Digits, + − × ÷, %, ± and clear."],
                          ["SCIENTIFIC", "Scientific", "Adds √, x², xʸ, sin, cos, tan, log, ln, π, parentheses and memory."],
                        ] as const
                      ).map(([value, label, hint]) => (
                        <label key={value} className="flex items-start gap-2">
                          <input type="radio" name="calculatorType" className="mt-1" checked={form.calculatorType === value} onChange={() => update({ calculatorType: value })} />
                          <span>
                            <span className="font-medium">{label}</span>
                            <span className="block text-xs text-muted-foreground">{hint}</span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  ) : null}
                  <div className="mt-3 border-t pt-3">
                    <ToggleRow
                      label="Spell check"
                      description="Allow browser-native spelling suggestions in learner text-answer fields. Misspellings are only marked; nothing is changed automatically."
                      checked={form.spellCheckEnabled}
                      disabled={locked("spellCheckEnabled")}
                      onChange={(v) => update({ spellCheckEnabled: v })}
                    />
                  </div>
                </ConfigGroup>
                <ConfigGroup title="Results">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="When learners see results" htmlFor="rv" error={err("resultVisibility")} hint={form.type === "OBJECTIVE" ? undefined : "Immediate results are only possible for objective assessments."}>
                      <SelectField
                        id="rv"
                        value={form.resultVisibility}
                        disabled={locked("resultVisibility")}
                        onChange={(v) => update({ resultVisibility: v as Form["resultVisibility"] })}
                        options={(Object.keys(RESULT_VISIBILITY_LABEL) as Form["resultVisibility"][]).map((k) => ({ value: k, label: RESULT_VISIBILITY_LABEL[k] }))}
                      />
                    </Field>
                    <Field label="What learners see" htmlFor="rd" error={err("resultDetail")}>
                      <SelectField
                        id="rd"
                        value={form.resultDetail}
                        disabled={locked("resultDetail")}
                        onChange={(v) => update({ resultDetail: v as Form["resultDetail"] })}
                        options={(Object.keys(RESULT_DETAIL_LABEL) as Form["resultDetail"][]).map((k) => ({ value: k, label: RESULT_DETAIL_LABEL[k] }))}
                      />
                    </Field>
                  </div>
                </ConfigGroup>
                <ConfigGroup title="Proctoring" description="Browser and camera monitoring during the exam. Camera monitoring is never on unless you require the camera." last>
                  <ProctoringSettings form={form} update={update} locked={locked} err={err} />
                </ConfigGroup>
              </Panel>
            </div>
          ) : null}

          {step === 3 ? (
            <Panel title="Schedule" description="When learners in the batch can take the assessment. All times are India Standard Time.">
              <div className="grid gap-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Start date" htmlFor="sd" error={err("startAt")}>
                      <Input id="sd" type="date" value={form.startDate} disabled={locked("startAt")} onChange={(e) => update({ startDate: e.target.value })} aria-invalid={!!err("startAt") || undefined} />
                    </Field>
                    <Field label="Start time" htmlFor="st">
                      <Input id="st" type="time" value={form.startTime} disabled={locked("startAt")} onChange={(e) => update({ startTime: e.target.value })} />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="End date" htmlFor="ed" error={err("endAt")}>
                      <Input id="ed" type="date" value={form.endDate} disabled={locked("endAt")} onChange={(e) => update({ endDate: e.target.value })} aria-invalid={!!err("endAt") || undefined} />
                    </Field>
                    <Field label="End time" htmlFor="et">
                      <Input id="et" type="time" value={form.endTime} disabled={locked("endAt")} onChange={(e) => update({ endTime: e.target.value })} />
                    </Field>
                  </div>
                </div>
                <Field label="Timezone">
                  <Input value="Asia/Kolkata (IST)" readOnly disabled />
                </Field>
                <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                  The assessment opens and closes automatically at these times. The window must be at least as long as the duration ({formatDuration(Number(form.durationMinutes) || 0)}), and the start must be in the future when you publish.
                </p>
              </div>
            </Panel>
          ) : null}

          {step === 4 && comm && communication ? (
            <Panel title="Communication" description="Which emails this assessment sends, with which template and when. No email service is connected yet: emails are recorded in Communication History as “not delivered”.">
              <CommunicationSettings value={comm} onChange={updateComm} templates={communication.templates} errors={errors} disabled={assessment?.status === "ARCHIVED"} />
            </Panel>
          ) : null}

          {step === 4 && !comm ? (
            <Panel title="Communication" description="Emails to learners about this assessment.">
              <div className="grid gap-3 text-sm">
                <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-4 py-3 text-amber-900 ring-1 ring-amber-200 ring-inset">
                  <Mail className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>
                    Email communication isn’t connected yet. This assessment stores no communication settings, and <span className="font-medium">no emails will be sent</span> when you publish.
                  </span>
                </p>
                <p className="text-muted-foreground">
                  When you publish, the {batch ? `${formatNumber(batch.learnerCount)} learners of ${batch.name}` : "batch’s learners"} are assigned to the assessment. Assignment emails, reminders and result notifications arrive with the Communication module.
                </p>
              </div>
            </Panel>
          ) : null}

          {step === LAST ? (
            !assessment ? (
              <EmptyState icon={FileStack} title="Save the basic details first" action={<Button onClick={() => goTo(0)}>Back to basic details</Button>} />
            ) : (
              <div className="grid gap-4">
                {assessment.status === "DRAFT" ? (
                  publishIssues.length ? (
                    <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
                      <p className="flex items-center gap-2 font-medium">
                        <AlertTriangle className="size-4" /> Fix these before publishing:
                      </p>
                      <ul className="mt-1 list-disc pl-6">
                        {publishIssues.map((i) => (
                          <li key={i}>{i}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900 ring-1 ring-emerald-200 ring-inset">
                      <CheckCircle2 className="size-4" /> {dirty ? "Save your changes to re-check." : "Ready to publish."}
                    </p>
                  )
                ) : null}
                <ReviewBlock title="Assessment details" onEdit={() => goTo(0)}>
                  <DetailList
                    items={[
                      ["Name", form.name],
                      ["Type", ASSESSMENT_TYPE_LABEL[form.type]],
                      ["Batch", batch ? `${batch.name} · ${formatNumber(batch.learnerCount)} learners` : (assessment.batch?.name ?? "—")],
                      ...(form.description ? ([["Description", form.description]] as [string, string][]) : []),
                      ["Instructions", <span key="i" className="whitespace-pre-line text-muted-foreground">{form.instructions || "—"}</span>],
                    ]}
                  />
                </ReviewBlock>
                <ReviewBlock title="Question paper" onEdit={() => goTo(1)}>
                  {paper && assessment.paper ? (
                    <>
                      <p className="mb-3 text-sm">
                        <span className="font-medium">{assessment.paper.name}</span>{" "}
                        <span className="text-muted-foreground">
                          · v{assessment.paper.version} · {totals?.questionCount} questions · {paper.sections.length} sections · {totals?.totalMarks} marks
                        </span>
                      </p>
                      <PaperStructure paper={paper} />
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">No question paper selected.</p>
                  )}
                </ReviewBlock>
                <ReviewBlock title="Configuration" onEdit={() => goTo(2)}>
                  <DetailList
                    items={[
                      ["Duration", `${formatDuration(Number(form.durationMinutes) || 0)} · ${form.timingMode === "WINDOW" ? "attempts end when the window closes" : "full duration if started within the window"}`],
                      ["Attempts", form.maxAttempts],
                      ["Passing marks", `${form.passingMarks}${totals ? ` of ${totals.totalMarks}` : ""}`],
                      ["Negative marking", form.negativeMarking ? "On (as set on the paper)" : "Off"],
                      ["Randomization", [form.randomizeQuestions && "Questions", form.randomizeOptions && "Options"].filter(Boolean).join(", ") || "Off"],
                      ["Learner experience", [form.allowResume && "Resume", form.showQuestionPalette && "Question palette", form.allowMarkForReview && "Mark for review"].filter(Boolean).join(", ") || "Minimal"],
                      ["Learner tools", [form.calculatorEnabled && `${form.calculatorType === "SCIENTIFIC" ? "Scientific" : "Basic"} calculator`, form.spellCheckEnabled && "Spell check"].filter(Boolean).join(", ") || "None"],
                      ["Results", `${RESULT_VISIBILITY_LABEL[form.resultVisibility]} · ${RESULT_DETAIL_LABEL[form.resultDetail]}`],
                      ["Proctoring", proctoringSummary({ ...form, focusMaxViolations: Number(form.focusMaxViolations) || 0 })],
                    ]}
                  />
                </ReviewBlock>
                <ReviewBlock title="Schedule" onEdit={() => goTo(3)}>
                  <DetailList
                    items={[
                      ["Opens", `${formatDateTime(`${form.startDate}T${form.startTime}:00+05:30`)} IST`],
                      ["Closes", `${formatDateTime(`${form.endDate}T${form.endTime}:00+05:30`)} IST`],
                    ]}
                  />
                </ReviewBlock>
                <ReviewBlock title="Communication" onEdit={() => goTo(4)}>
                  {comm && communication ? (
                    <ul className="grid gap-1 text-sm">
                      {COMMUNICATION_EVENTS.map((e) => (
                        <li key={e.key} className={comm[e.key].enabled ? undefined : "text-muted-foreground"}>
                          <span className="font-medium">{e.label}</span>
                          {": "}
                          {comm[e.key].enabled ? `${communication.templates.find((t) => t.id === comm[e.key].templateId)?.name ?? "—"}${comm[e.key].customize ? " (customised)" : ""} · ${e.timing.toLowerCase()}` : "off"}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">Save the basic details first.</p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">No email service is connected yet — emails are recorded, not sent.</p>
                </ReviewBlock>
              </div>
            )
          ) : null}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => (dirty ? setConfirmLeave(true) : router.push(assessment ? `/admin/assessments/${assessment.id}` : "/admin/assessments"))}>
                Cancel
              </Button>
              {step > 0 ? (
                <Button variant="outline" onClick={() => goTo(step - 1)} disabled={pending}>
                  Back
                </Button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={saveDraft} disabled={pending}>
                {isScheduled ? "Save changes" : "Save Draft"}
              </Button>
              {step < LAST ? (
                <Button onClick={() => goTo(step + 1)} disabled={pending}>
                  {pending ? "Saving…" : "Next"}
                </Button>
              ) : (
                <Button onClick={() => (isScheduled ? publish() : setConfirmPublish(true))} disabled={pending || !assessment || (!isScheduled && !dirty && !reviewReady)}>
                  <Send /> {isScheduled ? "Save & close" : "Publish Assessment"}
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
                  ["Batch", batch?.name ?? <span className="text-muted-foreground">—</span>],
                  ["Paper", assessment?.paper ? `${assessment.paper.name} · v${assessment.paper.version}` : <span className="text-muted-foreground">Not selected</span>],
                  ["Marks", totals && assessment?.paper ? totals.totalMarks : "—"],
                  ["Duration", formatDuration(Number(form.durationMinutes) || 0)],
                  ["Type", ASSESSMENT_TYPE_LABEL[form.type]],
                ]}
              />
            </Panel>
            <p className="px-1 text-xs text-muted-foreground">Saved to the database on every step.</p>
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        title="Publish Assessment?"
        description="The assessment is scheduled and the batch’s learners are assigned. The paper, batch and rules are then locked."
        confirmLabel="Publish Assessment"
        onConfirm={publish}
      >
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 rounded-lg border px-3 py-3 text-sm">
          <dt className="text-muted-foreground">Assessment</dt>
          <dd>
            <span className="font-medium">{form.name}</span>
            <span className="block text-xs text-muted-foreground">
              {assessment?.paper?.name} · {totals?.totalMarks} marks · {formatDuration(Number(form.durationMinutes) || 0)} · {form.maxAttempts} attempt{form.maxAttempts === "1" ? "" : "s"}
            </span>
          </dd>
          <dt className="text-muted-foreground">Batch</dt>
          <dd>
            {batch?.name ?? assessment?.batch?.name}
            <span className="block text-xs text-muted-foreground">{formatNumber(assessment?.batch?.learnerCount ?? 0)} active learners</span>
          </dd>
          <dt className="text-muted-foreground">Schedule</dt>
          <dd>
            {formatDateTime(`${form.startDate}T${form.startTime}:00+05:30`)} IST
            <span className="block text-xs text-muted-foreground">Closes {formatDateTime(`${form.endDate}T${form.endTime}:00+05:30`)} IST</span>
          </dd>
          <dt className="text-muted-foreground">Communication</dt>
          <dd className="text-muted-foreground">
            {comm && COMMUNICATION_EVENTS.some((e) => comm[e.key].enabled)
              ? `${COMMUNICATION_EVENTS.filter((e) => comm[e.key].enabled).map((e) => e.label).join(", ")} — recorded in Communication History (no email service connected)`
              : "All emails are off."}
          </dd>
        </dl>
      </ConfirmDialog>

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
          router.push(assessment ? `/admin/assessments/${assessment.id}` : "/admin/assessments");
        }}
      />
    </>
  );
}

function PaperStep({
  papers,
  selected,
  selectedView,
  locked,
  pending,
  error,
  onSelect,
  typeHint,
  type,
  totals,
  onMatchType,
}: {
  papers: PaperOption[];
  selected: AssessmentDetail["paper"];
  selectedView: QuestionPaper | null;
  locked: boolean;
  pending: boolean;
  error?: string;
  onSelect: (p: PaperOption) => void;
  typeHint: AssessmentType | null;
  type: AssessmentType;
  totals?: AssessmentDetail["totals"];
  onMatchType: (t: AssessmentType) => void;
}) {
  const [q, setQ] = useState("");
  const [changing, setChanging] = useState(!selected);
  const term = q.trim().toLowerCase();
  const rows = papers.filter((p) => !term || p.name.toLowerCase().includes(term) || (p.subject ?? "").toLowerCase().includes(term));
  const selectedCourse = selected ? papers.find((p) => p.id === selected.id)?.courseName : undefined;

  if (selected && selectedView && (!changing || locked)) {
    return (
      <Panel title="Selected question paper">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-base font-semibold">{selected.name}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {selectedCourse ? `${selectedCourse} · ` : ""}v{selected.version}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status="Ready" />
            {!locked ? (
              <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
                Change
              </Button>
            ) : null}
          </div>
        </div>
        <div className="mt-4">
          <PaperStats paper={selectedView} />
        </div>
        <PaperStructure paper={selectedView} className="mt-4" />
        {typeHint && totals ? (
          <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-amber-700">
            This paper has {totals.objectiveCount} objective and {totals.subjectiveCount} subjective questions, but the assessment type is {ASSESSMENT_TYPE_LABEL[type]}.
            {!locked ? (
              <button type="button" className="font-medium underline" onClick={() => onMatchType(typeHint)} disabled={pending}>
                Make it {ASSESSMENT_TYPE_LABEL[typeHint]}
              </button>
            ) : null}
          </p>
        ) : null}
      </Panel>
    );
  }

  return (
    <Panel
      title="Select Question Paper"
      description="Any saved, complete question paper can be used — no approval is needed."
      actions={
        selected ? (
          <Button variant="ghost" size="sm" onClick={() => setChanging(false)}>
            Keep current paper
          </Button>
        ) : null
      }
    >
      {error ? <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-destructive ring-1 ring-red-200 ring-inset">{error}</p> : null}
      <SearchInput value={q} onChange={setQ} placeholder="Search question papers…" className="mb-4 max-w-md" />
      {rows.length === 0 ? (
        <EmptyState icon={FileStack} title="No question papers found" description="Import or create a question paper (it needs sections and questions with marks), or adjust the search." />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {rows.map((p) => {
            const isSelected = selected?.id === p.id;
            return (
              <li key={p.id} className={cn("flex flex-col rounded-lg border bg-background p-4", isSelected && "border-primary ring-1 ring-primary")}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold">{p.name}</p>
                  <StatusBadge status="Ready" />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{[p.courseName, p.subject, p.durationMinutes ? `${p.durationMinutes} min` : null].filter(Boolean).join(" · ")}</p>
                <dl className="mt-3 grid grid-cols-4 gap-2 text-xs">
                  {[
                    [p.questionCount, "Questions"],
                    [p.sectionCount, "Sections"],
                    [p.totalMarks, "Marks"],
                    [`v${p.version}`, "Version"],
                  ].map(([v, l]) => (
                    <div key={String(l)}>
                      <dt className="text-muted-foreground">{l}</dt>
                      <dd className="font-medium tabular-nums">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
                  <span className="text-xs text-muted-foreground">Updated {formatDate(p.updatedAt.toISOString())}</span>
                  <Button
                    size="sm"
                    variant={isSelected ? "secondary" : "default"}
                    disabled={pending || isSelected}
                    onClick={() => {
                      onSelect(p);
                      setChanging(false);
                    }}
                    aria-label={`Select ${p.name} v${p.version}`}
                  >
                    {isSelected ? "Selected" : "Select"}
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

type ProctoringForm = Pick<Form, "proctoringEnabled" | "focusMonitoringEnabled" | "focusMaxViolations" | "focusViolationAction" | "fullscreenEnabled" | "clipboardMonitoringEnabled" | "cameraRequired" | "faceDetectionEnabled" | "multipleFaceDetectionEnabled" | "faceMissingDetectionEnabled" | "cameraSnapshotsEnabled" | "screenMonitoringEnabled">;

/**
 * Assessment → Configuration → Proctoring. Turning the master switch off hides the controls but keeps
 * what was chosen; camera detections can only be set while the camera is required. Controls whose
 * each describe what they actually do.
 */
function ProctoringSettings({ form, update, locked, err }: { form: ProctoringForm; update: (p: Partial<Form>) => void; locked: (f: AssessmentField) => boolean; err: (f: string) => string | undefined }) {
  const noCamera = "Available when the camera is required.";
  const partOfFace = "Part of face detection — turn that on first.";
  return (
    <>
      <ToggleRow
        label="Proctoring"
        description="Turns on the monitoring controls below. While off, nothing is monitored; your choices are kept."
        checked={form.proctoringEnabled}
        disabled={locked("proctoringEnabled")}
        onChange={(v) => update({ proctoringEnabled: v })}
      />
      {form.proctoringEnabled ? (
        <div className="mt-3 grid gap-5 border-t pt-4">
          <section aria-label="Browser controls">
            <h4 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Browser controls</h4>
            <ToggleRow
              label="Focus monitoring"
              description="Counts each time a learner leaves the exam tab or window (browser-based; it can’t detect another device)."
              checked={form.focusMonitoringEnabled}
              disabled={locked("focusMonitoringEnabled")}
              onChange={(v) => update({ focusMonitoringEnabled: v })}
            />
            <ToggleRow
              label="Fullscreen enforcement"
              description="Learners enter fullscreen to start; each exit counts as a violation and hides the questions until they return (browser-based, not a locked-down browser)."
              checked={form.fullscreenEnabled} disabled={locked("fullscreenEnabled")} onChange={(v) => update({ fullscreenEnabled: v })} />
            <ToggleRow
              label="Clipboard monitoring"
              description="Monitor supported copy, cut and paste activity during the assessment (only that it happened — never what was copied). Browser-based: not every clipboard action can be detected. Leave off when learners need to work with other documents."
              checked={form.clipboardMonitoringEnabled}
              disabled={locked("clipboardMonitoringEnabled")}
              onChange={(v) => update({ clipboardMonitoringEnabled: v })}
            />
          </section>
          <section aria-label="Camera monitoring">
            <h4 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Camera monitoring</h4>
            <ToggleRow
              label="Require camera"
              description="Learners pass a camera check before starting and keep the camera on; turning it off or blocking access is recorded for proctors (not counted as a violation — the exam continues with a warning). The live video is shown only to the learner — never recorded or streamed. No microphone."
              checked={form.cameraRequired}
              disabled={locked("cameraRequired")}
              onChange={(v) => update({ cameraRequired: v })}
            />
            <ToggleRow
              label="Face detection"
              description={
                form.cameraRequired
                  ? "Checks, in the learner’s browser only, that one face is in view: before the exam (to start) and during it. No images or video are recorded, stored or sent, and no one is identified."
                  : noCamera
              }
              checked={form.cameraRequired && form.faceDetectionEnabled}
              disabled={!form.cameraRequired || locked("faceDetectionEnabled")}
              onChange={(v) => update({ faceDetectionEnabled: v })}
            />
            <ToggleRow
              label="Multiple face detection"
              description={!form.cameraRequired ? noCamera : !form.faceDetectionEnabled ? partOfFace : "A second person staying in view (most of about 5 seconds) is recorded for proctors (not counted as a violation)."}
              checked={form.cameraRequired && form.faceDetectionEnabled && form.multipleFaceDetectionEnabled}
              disabled={!form.cameraRequired || !form.faceDetectionEnabled || locked("multipleFaceDetectionEnabled")}
              onChange={(v) => update({ multipleFaceDetectionEnabled: v })}
            />
            <ToggleRow
              label="Face missing detection"
              description={!form.cameraRequired ? noCamera : !form.faceDetectionEnabled ? partOfFace : "No face in view for about 10 seconds is recorded for proctors (not counted as a violation; the learner is warned on screen first)."}
              checked={form.cameraRequired && form.faceDetectionEnabled && form.faceMissingDetectionEnabled}
              disabled={!form.cameraRequired || !form.faceDetectionEnabled || locked("faceMissingDetectionEnabled")}
              onChange={(v) => update({ faceMissingDetectionEnabled: v })}
            />
          </section>
          <section aria-label="Proctoring evidence">
            <h4 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Proctoring evidence</h4>
            <ToggleRow
              label="Camera snapshots"
              description={
                form.cameraRequired
                  ? "A still image from the learner’s camera is kept every 3–5 minutes (at varying times) as proctoring evidence, viewable by administrators and assigned proctors only. Learners are told before they start. No video is recorded."
                  : noCamera
              }
              checked={form.cameraRequired && form.cameraSnapshotsEnabled}
              disabled={!form.cameraRequired || locked("cameraSnapshotsEnabled")}
              onChange={(v) => update({ cameraSnapshotsEnabled: v })}
            />
            <ToggleRow
              label="Screen monitoring"
              description="Learners share their entire screen to start, and a still image of it is kept every 3–5 minutes (at varying times) as proctoring evidence. Learners are told before they start. If sharing stops it is recorded and shown to proctors — it is not counted as a violation. No video is recorded."
              checked={form.screenMonitoringEnabled}
              disabled={locked("screenMonitoringEnabled")}
              onChange={(v) => update({ screenMonitoringEnabled: v })}
            />
          </section>
          <section aria-label="Violation policy" className="grid gap-4 sm:grid-cols-[12rem_1fr]">
            <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase sm:col-span-2">Violation policy</h4>
            <Field label="Maximum violations" htmlFor="focus-max" error={err("focusMaxViolations")} hint="Every violation counts towards one limit; the limit triggers the action.">
              <Input id="focus-max" type="number" min={1} max={20} step={1} value={form.focusMaxViolations} disabled={locked("focusMaxViolations")} onChange={(e) => update({ focusMaxViolations: e.target.value })} aria-invalid={!!err("focusMaxViolations") || undefined} />
            </Field>
            <fieldset className="grid gap-2 text-sm" disabled={locked("focusViolationAction")}>
              <legend className="mb-1 font-medium">Action at the limit</legend>
              {(
                [
                  ["WARN", "Warn", "The violation is recorded and the learner is warned; the exam continues."],
                  ["LOCK", "Lock exam", "No more answering or submitting; the attempt closes at its deadline with the answers saved before the lock."],
                  ["TERMINATE", "Terminate exam", "The attempt is terminated; saved answers are kept but it isn’t a submission."],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} className="flex items-start gap-2">
                  <input type="radio" name="focusViolationAction" className="mt-1" checked={form.focusViolationAction === value} onChange={() => update({ focusViolationAction: value })} />
                  <span>
                    <span className="font-medium">{label}</span>
                    <span className="block text-xs text-muted-foreground">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </section>
        </div>
      ) : null}
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

function ReviewBlock({ title, onEdit, children }: { title: string; onEdit: () => void; children: React.ReactNode }) {
  return (
    <Panel
      title={title}
      actions={
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil /> Edit
        </Button>
      }
    >
      {children}
    </Panel>
  );
}
