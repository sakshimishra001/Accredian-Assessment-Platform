"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Bookmark, CheckCircle2, ChevronLeft, ChevronRight, CircleCheck, Clock, CloudCheck, Eraser, Send } from "lucide-react";
import { cn } from "cn";
import { Logo } from "@/components/proto/app-shell";
import { useLearnerAssessments } from "@/components/proto/learner-data";
import { AnswerUpload, FileWorkflowSteps } from "@/components/proto/answer-upload";
import { MaterialList } from "@/components/proto/materials";
import { DetailList, EmptyState, PrototypeNote } from "@/components/proto/page";
import { PaperStructure } from "@/components/proto/paper-summary";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime, formatDuration } from "@/prototype/lib/format";
import { hasOptions, paperTotals, QUESTION_TYPE_LABEL, ruleText, sectionQuestions } from "@/prototype/lib/paper";
import { acceptsFiles, answerState, missingRequiredFile, responseOf, type AnswerDraft } from "@/prototype/lib/response";
import { useLookups } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { LearnerAnswer, Question } from "@/prototype/types";

interface Item {
  q: Question;
  parent?: Question;
  sectionId: string;
}

const EMPTY: AnswerDraft = { selected: [], text: "", attachments: [] };

function buildItems(questions: Question[]): Item[] {
  return questions.flatMap((q) => (q.children.length ? q.children.map((c) => ({ q: c, parent: q, sectionId: q.sectionId })) : [{ q, sectionId: q.sectionId }]));
}

export default function LearnerAttemptPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const lookup = useLookups();
  const { active, me } = useLearnerAssessments();
  const toast = useToast();
  const a = lookup.assessment(id);
  const paper = lookup.paper(a?.paperId ?? null);
  const canStart = active.some((x) => x.id === id);

  const [phase, setPhase] = useState<"instructions" | "exam" | "submitted">("instructions");
  const [agreed, setAgreed] = useState(false);
  const [index, setIndex] = useState(0);
  // Learner answers for this attempt, keyed by question. Attachments live here — never on the question.
  const [answers, setAnswers] = useState<Record<string, AnswerDraft>>({});
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  const [previewed, setPreviewed] = useState<Set<string>>(new Set());
  const [fileError, setFileError] = useState<string | null>(null);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [visited, setVisited] = useState<Set<string>>(new Set());
  // Timer: a fixed deadline set on start; the interval only refreshes "now".
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  const items = paper ? buildItems(paper.questions) : [];
  const current = items[index];

  useEffect(() => {
    if (phase !== "exam") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const remaining = deadline === null ? (a?.durationMinutes ?? 60) * 60 : Math.max(0, Math.round((deadline - now) / 1000));
  const timeUp = phase === "exam" && remaining === 0;

  const goToIndex = (i: number) => {
    setIndex(i);
    setFileError(null);
    const q = items[i]?.q;
    if (q) setVisited((v) => (v.has(q.id) ? v : new Set(v).add(q.id)));
  };

  const startExam = () => {
    const t = Date.now();
    setDeadline(t + (a?.durationMinutes ?? 60) * 60 * 1000);
    setNow(t);
    setPhase("exam");
    goToIndex(0);
  };

  if (!a || !paper) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
        <EmptyState title="Assessment not available" description="It may have been created in a previous session." action={<Link href="/learner" className={buttonVariants()}>Back to dashboard</Link>} />
      </div>
    );
  }

  const totals = paperTotals(paper);
  const stateOf = (q: Question) => answerState(q, answers[q.id]);
  const isAnswered = (q: Question) => stateOf(q) === "complete";
  const answeredCount = items.filter((it) => isAnswered(it.q)).length;
  const save = (qid: string, patch: Partial<AnswerDraft>) => {
    setAnswers((prev) => ({ ...prev, [qid]: { ...(prev[qid] ?? EMPTY), ...patch } }));
    setSavedAt(new Date().toISOString());
  };
  const fileItems = items.map((it, i) => ({ it, i })).filter(({ it }) => !hasOptions(it.q.type) && acceptsFiles(responseOf(it.q)));
  const missingFiles = fileItems.filter(({ it }) => missingRequiredFile(it.q, answers[it.q.id]));
  /** The attempt as a future backend would model it: Assessment → Attempt → Question → Answer → Attachments. */
  const attemptAnswers: LearnerAnswer[] = items.map((it) => ({
    assessmentId: id,
    attemptNo: 1,
    learnerId: me.id,
    questionId: it.q.id,
    ...(answers[it.q.id] ?? EMPTY),
  }));

  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");
  const lowTime = remaining < 5 * 60;

  if (phase === "instructions") {
    return (
      <div className="min-h-screen bg-canvas">
        <header className="flex h-14 items-center justify-between border-b bg-background px-4 md:px-6">
          <Logo />
          <Link href="/learner" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> Back to dashboard
          </Link>
        </header>
        <main className="mx-auto grid max-w-3xl gap-6 px-4 py-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{a.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {lookup.course(a.courseId)?.name} · {lookup.batch(a.batchId)?.label}
            </p>
          </div>
          <div className="rounded-lg border bg-card p-5">
            <DetailList
              items={[
                ["Duration", formatDuration(a.durationMinutes)],
                ["Total marks", String(totals.marks)],
                ["Questions", `${totals.questions} in ${totals.sections} sections`],
                ["Negative marking", a.negativeMarking ? `−${a.negativeMarks} per wrong objective answer` : "None"],
                ["Window", `${formatDateTime(a.schedule.start)} – ${formatDateTime(a.schedule.end)} IST`],
                ["Attempts", String(a.maxAttempts)],
              ]}
            />
          </div>
          <div className="rounded-lg border bg-card p-5">
            <h2 className="mb-3 text-sm font-semibold">Sections</h2>
            <PaperStructure paper={paper} />
          </div>
          <div className="rounded-lg border bg-card p-5">
            <h2 className="mb-3 text-sm font-semibold">Instructions</h2>
            <ul className="grid list-disc gap-1.5 pl-5 text-sm">
              {a.instructions.split("\n").filter(Boolean).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <label className="mt-5 flex items-center gap-2 text-sm">
              <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(Boolean(v))} />
              I have read and understood the instructions.
            </label>
          </div>
          {canStart ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <PrototypeNote>Prototype — answers are not saved or scored.</PrototypeNote>
              <Button size="lg" className="h-10 px-5" disabled={!agreed} onClick={startExam}>
                Start Assessment
              </Button>
            </div>
          ) : (
            <p className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">This assessment opens on {formatDateTime(a.schedule.start)} IST.</p>
          )}
        </main>
      </div>
    );
  }

  if (phase === "submitted" || timeUp) {
    const objectiveOnly = totals.subjective === 0;
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
        <div className="w-full max-w-lg rounded-lg border bg-card p-8 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-50">
            <CheckCircle2 className="size-7 text-emerald-600" />
          </div>
          <h1 className="mt-4 text-xl font-semibold">{timeUp ? "Time’s up — submitted" : "Assessment submitted"}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You answered {answeredCount} of {items.length} questions. {objectiveOnly && a.settings.showResultsImmediately ? "Your score is being calculated." : "Your result will be available once it is published."}
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Attempt #1 · {me.name} · Submission ID: SUB-{id.slice(-6).toUpperCase()} · {formatDateTime(new Date().toISOString())}
          </p>
          {attemptAnswers.some((x) => x.attachments.length) ? (
            <div className="mt-5 text-left">
              <p className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Files submitted</p>
              <ul className="divide-y rounded-lg border text-sm">
                {attemptAnswers
                  .filter((x) => x.attachments.length)
                  .map((x) => {
                    const q = items.find((it) => it.q.id === x.questionId)!.q;
                    return (
                      <li key={x.questionId} className="flex items-center gap-2 px-3 py-2">
                        <CircleCheck className="size-4 text-emerald-600" />
                        <span className="font-medium">Q{q.number}</span>
                        <span className="truncate text-muted-foreground">{x.attachments.map((f) => f.name).join(", ")}</span>
                      </li>
                    );
                  })}
              </ul>
            </div>
          ) : null}
          <Button className="mt-6" onClick={() => router.push("/learner")}>
            Back to dashboard
          </Button>
        </div>
      </div>
    );
  }

  const section = paper.sections.find((s) => s.id === current.sectionId)!;
  const ans = answers[current.q.id] ?? EMPTY;
  const response = responseOf(current.q);
  // Admin-attached material for this question (and its parent group, e.g. a case study's exhibit).
  const materials = [...(current.parent?.materials ?? []), ...(current.q.materials ?? [])];
  const showPalette = a.settings.showQuestionPalette;
  const multi = current.q.type === "MCQ_MULTI";

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background px-4 md:px-6">
        <span className="hidden sm:block">
          <Logo collapsed />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{a.name}</p>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <CloudCheck className="size-3.5 text-emerald-600" /> {savedAt ? "All answers saved" : "Answers save automatically"} · Attempt #1
          </p>
        </div>
        <div className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-sm font-semibold tabular-nums", lowTime ? "bg-red-50 text-red-700" : "bg-muted")} aria-live="polite" aria-label={`Time remaining ${mm} minutes ${ss} seconds`}>
          <Clock className="size-4" /> {mm}:{ss}
        </div>
        <Button onClick={() => setConfirmSubmit(true)}>
          <Send /> Submit
        </Button>
      </header>

      <div className={cn("mx-auto grid w-full max-w-7xl flex-1 gap-4 p-4", showPalette && "lg:grid-cols-[1fr_18rem]")}>
        <main className="min-w-0 self-start rounded-lg border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
            <div>
              <p className="text-sm font-semibold">{section.name}</p>
              <p className="text-xs text-muted-foreground">{ruleText(section, sectionQuestions(paper, section.id).length)} · {section.marks} marks</p>
            </div>
            <span className="text-xs text-muted-foreground">
              {index + 1} of {items.length} to answer
            </span>
          </div>
          <div className="grid gap-4 p-5">
            {current.parent?.passage ? (
              <div className="max-h-64 overflow-auto rounded-lg border bg-muted/40 px-4 py-3 text-sm leading-relaxed">
                <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{current.parent.type === "CASE_STUDY" ? "Case" : "Passage"} · Q{current.parent.number}</p>
                {current.parent.passage}
              </div>
            ) : null}
            <div className="flex items-start justify-between gap-3">
              <p className="text-base leading-relaxed">
                <span className="mr-2 font-semibold">Q{current.q.number}.</span>
                {current.q.text}
              </p>
              <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {current.q.marks} mark{current.q.marks === 1 ? "" : "s"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{QUESTION_TYPE_LABEL[current.q.type]}{multi ? " — select all that apply" : ""}</p>
            {materials.length ? (
              <section aria-label="Supporting Material" className="rounded-lg bg-muted/40 p-3">
                <p className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Supporting Material</p>
                <MaterialList materials={materials} mode="learner" className="bg-background" onDownload={() => setDownloaded((d) => new Set(d).add(current.q.id))} />
              </section>
            ) : null}
            {hasOptions(current.q.type) ? (
              <ul className="grid gap-2" role={multi ? "group" : "radiogroup"}>
                {current.q.options.map((o, i) => {
                  const checked = ans.selected.includes(o.id);
                  return (
                    <li key={o.id}>
                      <button
                        type="button"
                        role={multi ? "checkbox" : "radio"}
                        aria-checked={checked}
                        onClick={() => save(current.q.id, { selected: multi ? (checked ? ans.selected.filter((x) => x !== o.id) : [...ans.selected, o.id]) : [o.id] })}
                        className={cn("flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors", checked ? "border-primary bg-accent/60 ring-1 ring-primary" : "hover:bg-muted/60")}
                      >
                        <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium", multi && "rounded-md", checked && "border-primary bg-primary text-primary-foreground")}>
                          {String.fromCharCode(65 + i)}
                        </span>
                        {o.text || "—"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="grid gap-5">
                {current.q.instructions ? (
                  <div className="rounded-md border-l-2 border-primary bg-accent/40 px-3 py-2 text-sm">
                    <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Instructions</p>
                    <p className="mt-0.5">{current.q.instructions}</p>
                  </div>
                ) : null}
                {response.type === "file" && materials.length ? (
                  <FileWorkflowSteps downloaded={downloaded.has(current.q.id)} uploaded={ans.attachments.length > 0} previewed={previewed.has(current.q.id)} />
                ) : null}
                <div className="grid gap-4 border-t pt-4">
                  {response.type === "text" ? (
                    <div>
                      <p className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Your Answer</p>
                      <Textarea
                        rows={current.q.type === "LONG_ANSWER" ? 12 : 5}
                        value={ans.text}
                        onChange={(e) => save(current.q.id, { text: e.target.value })}
                        placeholder="Type your answer…"
                        aria-label={`Answer for question ${current.q.number}`}
                      />
                      <p className="mt-1 text-right text-xs text-muted-foreground">{ans.text.trim() ? ans.text.trim().split(/\s+/).length : 0} words</p>
                    </div>
                  ) : null}
                  {response.type === "text_file" ? (
                    <div>
                      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Your Answer</p>
                      <label htmlFor={`ans-${current.q.id}`} className="mt-1 mb-1.5 block text-sm text-muted-foreground">
                        Your written answer
                      </label>
                      <Textarea
                        id={`ans-${current.q.id}`}
                        rows={8}
                        value={ans.text}
                        onChange={(e) => save(current.q.id, { text: e.target.value })}
                        placeholder="Enter your explanation…"
                      />
                      <p className="mt-1 text-right text-xs text-muted-foreground">{ans.text.trim() ? ans.text.trim().split(/\s+/).length : 0} words</p>
                    </div>
                  ) : null}
                  {acceptsFiles(response) ? (
                    <AnswerUpload
                      key={current.q.id}
                      config={response}
                      attachments={ans.attachments}
                      onChange={(attachments) => {
                        save(current.q.id, { attachments });
                        setFileError(null);
                      }}
                      onPreview={() => setPreviewed((p) => new Set(p).add(current.q.id))}
                      questionLabel={`Question ${current.q.number}`}
                      heading={response.type === "file" ? "Your Answer" : "Answer attachment"}
                      helper={
                        response.type === "file"
                          ? materials.length
                            ? "Download the file, complete your work, and upload the completed file below."
                            : "Upload your completed file below."
                          : `Attach the document that supports your written answer${response.fileRequired ? " (required)" : " (optional)"}.`
                      }
                    />
                  ) : null}
                  {fileError ? (
                    <p className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-900 ring-1 ring-red-200 ring-inset" role="alert">
                      <AlertTriangle className="size-4 shrink-0" /> {fileError}
                    </p>
                  ) : null}
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3">
            <div className="flex gap-2">
              {a.settings.allowMarkForReview ? (
                <Button variant="outline" onClick={() => setMarked((m) => { const n = new Set(m); if (n.has(current.q.id)) n.delete(current.q.id); else n.add(current.q.id); return n; })}>
                  <Bookmark className={cn(marked.has(current.q.id) && "fill-current")} /> {marked.has(current.q.id) ? "Unmark" : "Mark for review"}
                </Button>
              ) : null}
              <Button variant="ghost" disabled={!ans.selected.length && !ans.text.trim()} onClick={() => save(current.q.id, { selected: [], text: "" })}>
                <Eraser /> Clear
              </Button>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" disabled={index === 0} onClick={() => goToIndex(index - 1)}>
                <ChevronLeft /> Previous
              </Button>
              {index < items.length - 1 ? (
                <Button
                  onClick={() => {
                    if (missingRequiredFile(current.q, ans)) {
                      const msg = "Please upload the required answer file before continuing.";
                      setFileError(msg);
                      toast.error(msg);
                      return;
                    }
                    goToIndex(index + 1);
                  }}
                >
                  Save & Next <ChevronRight />
                </Button>
              ) : (
                <Button onClick={() => setConfirmSubmit(true)}>
                  <Send /> Finish
                </Button>
              )}
            </div>
          </div>
        </main>

        {showPalette ? (
        <aside className="rounded-lg border bg-card p-4 lg:sticky lg:top-18 lg:self-start">
          <p className="text-sm font-semibold">Question navigation</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {answeredCount} answered · {items.length - answeredCount} remaining
          </p>
          <div className="mt-3 grid max-h-[55vh] gap-3 overflow-auto">
            {paper.sections.map((s) => {
              const sItems = items.map((it, i) => ({ it, i })).filter(({ it }) => it.sectionId === s.id);
              return (
                <div key={s.id}>
                  <p className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{s.name.split(" — ")[0]}</p>
                  <div className="grid grid-cols-6 gap-1.5">
                    {sItems.map(({ it, i }) => {
                      const st = stateOf(it.q);
                      const answered = st === "complete";
                      const isMarked = marked.has(it.q.id);
                      const seen = visited.has(it.q.id);
                      return (
                        <button
                          key={it.q.id}
                          type="button"
                          onClick={() => goToIndex(i)}
                          aria-label={`Question ${it.q.number}${answered ? ", answered" : st === "partial" ? ", in progress" : ""}${isMarked ? ", marked for review" : ""}`}
                          aria-current={i === index ? "true" : undefined}
                          className={cn(
                            "relative h-8 rounded-md border text-[11px] font-medium tabular-nums",
                            answered ? "border-emerald-600 bg-emerald-600 text-white" : st === "partial" ? "border-emerald-600 bg-emerald-50 text-emerald-800" : seen ? "border-amber-300 bg-amber-50 text-amber-900" : "bg-background text-muted-foreground",
                            isMarked && "ring-2 ring-violet-500 ring-offset-1",
                            i === index && "outline-2 outline-offset-2 outline-primary",
                          )}
                        >
                          {it.q.number}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <ul className="mt-4 grid gap-1.5 border-t pt-3 text-xs text-muted-foreground">
            <li className="flex items-center gap-2"><span className="size-3 rounded-sm bg-emerald-600" /> Answered</li>
            <li className="flex items-center gap-2"><span className="size-3 rounded-sm border border-emerald-600 bg-emerald-50" /> In progress (part missing)</li>
            <li className="flex items-center gap-2"><span className="size-3 rounded-sm border border-amber-300 bg-amber-50" /> Visited, not answered</li>
            <li className="flex items-center gap-2"><span className="size-3 rounded-sm border" /> Not visited</li>
            <li className="flex items-center gap-2"><span className="size-3 rounded-sm ring-2 ring-violet-500" /> Marked for review</li>
          </ul>
        </aside>
        ) : null}
      </div>

      <Dialog open={confirmSubmit} onOpenChange={setConfirmSubmit}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Submit Assessment?</DialogTitle>
            <DialogDescription>
              You have answered {answeredCount} of {items.length} questions. You can’t change your answers after submitting.
            </DialogDescription>
          </DialogHeader>

          {fileItems.length ? (
            <div>
              <p className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">File submissions</p>
              <ul className="divide-y rounded-lg border">
                {fileItems.map(({ it, i }) => {
                  const att = answers[it.q.id]?.attachments ?? [];
                  const missing = missingRequiredFile(it.q, answers[it.q.id]);
                  return (
                    <li key={it.q.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                      {missing ? <AlertTriangle className="size-4 text-amber-600" aria-label="Missing" /> : <CircleCheck className="size-4 text-emerald-600" aria-label="Attached" />}
                      <span className="font-medium">Question {it.q.number}</span>
                      <span className={cn("min-w-0 flex-1 truncate", missing ? "text-amber-800" : "text-muted-foreground")}>
                        — {missing ? "Required file missing" : att.length ? att.map((x) => x.name).join(", ") : "No file (optional)"}
                      </span>
                      {missing ? (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => {
                            setConfirmSubmit(false);
                            goToIndex(i);
                          }}
                        >
                          Go to question
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <div>
            <p className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Review</p>
            <div className="max-h-56 overflow-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Question</th>
                    <th className="px-3 py-1.5 text-left font-medium">Answer</th>
                    <th className="px-3 py-1.5 text-left font-medium">File</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => {
                    const st = answerState(it.q, answers[it.q.id]);
                    const r = responseOf(it.q);
                    const needsFile = !hasOptions(it.q.type) && acceptsFiles(r);
                    const att = answers[it.q.id]?.attachments ?? [];
                    const missing = missingRequiredFile(it.q, answers[it.q.id]);
                    return (
                      <tr key={it.q.id} className="border-t">
                        <td className="px-3 py-1.5 font-medium tabular-nums">Q{it.q.number}</td>
                        <td className={cn("px-3 py-1.5", st === "complete" ? "text-emerald-700" : st === "partial" ? "text-amber-700" : "text-muted-foreground")}>
                          {st === "complete" ? "✓ Answer provided" : st === "partial" ? "In progress" : "Not answered"}
                        </td>
                        <td className={cn("px-3 py-1.5", missing ? "text-amber-800" : "text-muted-foreground")}>
                          {!needsFile ? "No file required" : missing ? "⚠ Required file not uploaded" : att.length ? `✓ ${att[0].name}` : "Optional — none"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {missingFiles.length ? (
            <p className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset" role="alert">
              <AlertTriangle className="size-4 shrink-0" /> Please complete the required file uploads before submitting.
            </p>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSubmit(false)}>
              Keep working
            </Button>
            <Button
              disabled={missingFiles.length > 0}
              onClick={() => {
                setConfirmSubmit(false);
                setPhase("submitted");
                toast.success("Assessment submitted successfully.");
              }}
            >
              Submit Assessment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
