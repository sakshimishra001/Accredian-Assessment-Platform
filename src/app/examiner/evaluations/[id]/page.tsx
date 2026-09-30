"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Save, Send } from "lucide-react";
import { ConfirmDialog } from "@/components/proto/controls";
import { DetailList, EmptyState, PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, percent } from "@/prototype/lib/format";
import { useLookups, useProto, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { EvaluationAnswer } from "@/prototype/types";

export default function EvaluationPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const s = useProto();
  const lookup = useLookups();
  const { updateEvaluation } = useProtoActions();
  const ev = s.evaluations.find((e) => e.id === id);
  const [answers, setAnswers] = useState<EvaluationAnswer[]>(ev?.answers ?? []);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  if (!ev) {
    return <EmptyState className="mt-10" title="Evaluation not found" action={<Link href="/examiner" className={buttonVariants()}>Back to dashboard</Link>} />;
  }

  const readOnly = ev.status === "Completed";
  const assessment = lookup.assessment(ev.assessmentId);
  const learner = lookup.learner(ev.learnerId);
  const max = answers.reduce((n, a) => n + a.maxMarks, 0);
  const awarded = answers.reduce((n, a) => n + (a.marks ?? 0), 0);
  const markedCount = answers.filter((a) => a.marks !== null).length;

  const setAnswer = (i: number, patch: Partial<EvaluationAnswer>) => {
    setAnswers((list) => list.map((a, j) => (j === i ? { ...a, ...patch } : a)));
    setDirty(true);
  };

  function validate(requireAll: boolean) {
    const e: Record<number, string> = {};
    answers.forEach((a, i) => {
      if (a.marks === null) {
        if (requireAll) e[i] = "Award marks before submitting.";
      } else if (a.marks < 0 || a.marks > a.maxMarks) e[i] = `Marks must be between 0 and ${a.maxMarks}.`;
      else if (Math.round(a.marks * 2) !== a.marks * 2) e[i] = "Use whole or half marks.";
    });
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Evaluations", href: "/examiner/evaluations" }, { label: `Script ${ev.id.toUpperCase()}` }]}
        title={learner?.name ?? "Learner"}
        meta={<StatusBadge status={ev.status} />}
        description={`${assessment?.name} · due ${formatDate(ev.dueDate)}`}
        actions={
          readOnly ? null : (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  if (!validate(false)) {
                    toast.error("Please fix the highlighted marks");
                    return;
                  }
                  updateEvaluation(ev.id, { answers, status: markedCount ? "In progress" : ev.status });
                  setDirty(false);
                  toast.success("Evaluation saved", `${markedCount} of ${answers.length} answers marked.`);
                }}
              >
                <Save /> Save Evaluation
              </Button>
              <Button
                onClick={() => {
                  if (!validate(true)) {
                    toast.error("Every answer needs marks before submitting");
                    return;
                  }
                  setConfirm(true);
                }}
              >
                <Send /> Submit Evaluation
              </Button>
            </>
          )
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="grid content-start gap-4">
          {answers.map((a, i) => (
            <Panel key={a.questionNumber} title={`Q${a.questionNumber}`} description={`Maximum ${a.maxMarks} marks`}>
              <p className="text-sm leading-relaxed">{a.questionText}</p>
              <div className="mt-3 rounded-lg border bg-muted/40 px-4 py-3">
                <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Learner’s answer</p>
                <p className="text-sm leading-relaxed whitespace-pre-line">{a.answer}</p>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-[8rem_1fr]">
                <div className="grid gap-1.5">
                  <label htmlFor={`m-${i}`} className="text-sm font-medium">
                    Marks
                  </label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      id={`m-${i}`}
                      type="number"
                      min={0}
                      max={a.maxMarks}
                      step={0.5}
                      value={a.marks ?? ""}
                      disabled={readOnly}
                      aria-invalid={!!errors[i] || undefined}
                      onChange={(e) => setAnswer(i, { marks: e.target.value === "" ? null : Number(e.target.value) })}
                    />
                    <span className="text-sm text-muted-foreground">/ {a.maxMarks}</span>
                  </div>
                  {errors[i] ? <p className="text-xs text-destructive">{errors[i]}</p> : null}
                </div>
                <div className="grid gap-1.5">
                  <label htmlFor={`c-${i}`} className="text-sm font-medium">
                    Comments
                  </label>
                  <Textarea id={`c-${i}`} rows={2} value={a.comment} disabled={readOnly} placeholder="Feedback for the learner (optional)" onChange={(e) => setAnswer(i, { comment: e.target.value })} />
                </div>
              </div>
            </Panel>
          ))}
        </div>

        <aside className="grid content-start gap-4 lg:sticky lg:top-20 lg:self-start">
          <Panel title="Summary">
            <p className="text-2xl font-semibold tabular-nums">
              {awarded} <span className="text-base font-normal text-muted-foreground">/ {max}</span>
            </p>
            <Progress value={percent(markedCount, answers.length)} className="mt-3" />
            <p className="mt-2 text-xs text-muted-foreground">
              {markedCount} of {answers.length} answers marked
            </p>
          </Panel>
          <Panel title="Script">
            <DetailList
              className="grid-cols-[5rem_1fr]"
              items={[
                ["Learner", learner?.name],
                ["Batch", lookup.batch(learner?.batchId ?? "")?.label],
                ["Assessment", assessment?.name],
                ["Due", formatDate(ev.dueDate)],
              ]}
            />
          </Panel>
        </aside>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Submit this evaluation?"
        description={`Total ${awarded} / ${max}. You won’t be able to change marks after submitting.`}
        confirmLabel="Submit Evaluation"
        onConfirm={() => {
          updateEvaluation(ev.id, { answers, status: "Completed" });
          setDirty(false);
          toast.success("Evaluation submitted", `${learner?.name}: ${awarded} / ${max}`);
          router.push("/examiner");
        }}
      />
    </>
  );
}
