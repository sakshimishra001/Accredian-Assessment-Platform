"use client";

import { Info, Plus, Trash2 } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ATTEMPT_RULE_LABEL, RULE_HELP, RULES_WITH_COUNT, paperTotals, ruleText, sectionQuestions } from "@/prototype/lib/paper";
import { newId, useProto } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { AttemptRuleKind, QuestionPaper, Section } from "@/prototype/types";
import { Field, SelectField } from "../controls";
import { Panel } from "../page";

const REQUIRED_RULES: AttemptRuleKind[] = ["COMPULSORY", "ANY_N", "EXACTLY_N", "BEST_N"];
const OPTIONAL_RULES: AttemptRuleKind[] = ["OPTIONAL", "UP_TO_N", "ANY_N", "BEST_N"];
export const isRequiredRule = (r: AttemptRuleKind) => r !== "OPTIONAL" && r !== "UP_TO_N";

export function validateDetails(p: QuestionPaper): Record<string, string> {
  const e: Record<string, string> = {};
  if (p.name.trim().length < 3) e.name = "Enter a question paper name.";
  if (!p.courseId) e.courseId = "Choose a course.";
  if (!p.batchId) e.batchId = "Choose a batch.";
  if (!p.subject.trim()) e.subject = "Enter a subject.";
  if (p.sections.length === 0) e.sections = "Add at least one section.";
  p.sections.forEach((s) => {
    const count = sectionQuestions(p, s.id).length;
    if (!s.name.trim()) e[`s-${s.id}-name`] = "Name the section.";
    if (!(s.marks > 0)) e[`s-${s.id}-marks`] = "Marks must be more than 0.";
    if (RULES_WITH_COUNT.includes(s.rule)) {
      if (!s.ruleCount || s.ruleCount < 1) e[`s-${s.id}-n`] = "Enter N.";
      else if (count && s.ruleCount > count) e[`s-${s.id}-n`] = `N can’t exceed ${count} questions.`;
    }
  });
  return e;
}

export function DetailsStep({ paper, onChange, errors }: { paper: QuestionPaper; onChange: (p: QuestionPaper) => void; errors: Record<string, string> }) {
  const state = useProto();
  const toast = useToast();
  const totals = paperTotals(paper);
  const set = (patch: Partial<QuestionPaper>) => onChange({ ...paper, ...patch });
  const setSection = (id: string, patch: Partial<Section>) => set({ sections: paper.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

  function addSection() {
    const letter = String.fromCharCode(65 + paper.sections.length);
    set({ sections: [...paper.sections, { id: newId("s"), name: `Section ${letter}`, range: "", rule: "COMPULSORY", marks: 10 }] });
  }

  function removeSection(s: Section) {
    const count = sectionQuestions(paper, s.id).length;
    if (count) {
      toast.error("Section has questions", `Move or delete its ${count} question${count === 1 ? "" : "s"} in the review step first.`);
      return;
    }
    set({ sections: paper.sections.filter((x) => x.id !== s.id) });
  }

  return (
    <div className="grid gap-6">
      <Panel title="Question paper details">
        <div className="grid gap-4">
          <Field label="Question paper name" htmlFor="pname" required error={errors.name}>
            <Input id="pname" value={paper.name} onChange={(e) => set({ name: e.target.value })} placeholder="Batch 1 – Product Management – Mid Term 1" />
          </Field>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Course" htmlFor="pcourse" required error={errors.courseId}>
              <SelectField
                id="pcourse"
                value={paper.courseId}
                onChange={(v) => set({ courseId: v, batchId: state.batches.find((b) => b.courseId === v)?.id ?? "" })}
                placeholder="Select a course"
                options={state.courses.map((c) => ({ value: c.id, label: c.name }))}
              />
            </Field>
            <Field label="Subject" htmlFor="psub" required error={errors.subject}>
              <Input id="psub" value={paper.subject} onChange={(e) => set({ subject: e.target.value })} />
            </Field>
            <Field label="Batch" htmlFor="pbatch" required error={errors.batchId}>
              <SelectField
                id="pbatch"
                value={paper.batchId}
                onChange={(v) => set({ batchId: v })}
                placeholder="Select a batch"
                options={state.batches.filter((b) => !paper.courseId || b.courseId === paper.courseId).map((b) => ({ value: b.id, label: b.label }))}
              />
            </Field>
          </div>
          <div className="grid gap-4 md:grid-cols-[1fr_8rem_10rem]">
            <Field label="Description" htmlFor="pdesc">
              <Textarea id="pdesc" rows={2} value={paper.description} onChange={(e) => set({ description: e.target.value })} />
            </Field>
            <Field label="Version" htmlFor="pver">
              <Input id="pver" value={paper.version} onChange={(e) => set({ version: e.target.value })} />
            </Field>
            <Field label="Suggested duration" htmlFor="pdur" hint="Minutes">
              <Input id="pdur" type="number" min={5} value={paper.durationMinutes} onChange={(e) => set({ durationMinutes: Number(e.target.value) })} />
            </Field>
          </div>
        </div>
      </Panel>

      <Panel
        title="Question paper structure"
        description="Sections, which questions they contain and how learners must attempt them."
        actions={
          <Button size="sm" variant="outline" onClick={addSection}>
            <Plus /> Add Section
          </Button>
        }
      >
        {errors.sections ? <p className="mb-3 text-sm text-destructive">{errors.sections}</p> : null}
        <div className="grid gap-3">
          {paper.sections.map((s) => {
            const count = sectionQuestions(paper, s.id).length;
            const required = isRequiredRule(s.rule);
            const rules = required ? REQUIRED_RULES : OPTIONAL_RULES;
            return (
              <div key={s.id} className="rounded-lg border p-4">
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_7rem_8rem_minmax(0,1.3fr)_5rem_6rem_auto] lg:items-start">
                  <Field label="Section name" error={errors[`s-${s.id}-name`]}>
                    <Input value={s.name} onChange={(e) => setSection(s.id, { name: e.target.value })} aria-label="Section name" />
                  </Field>
                  <Field label="Question range">
                    <Input value={s.range} onChange={(e) => setSection(s.id, { range: e.target.value })} placeholder="Q1–Q2" aria-label="Question range" />
                  </Field>
                  <Field label="Requirement">
                    <SelectField
                      value={required ? "required" : "optional"}
                      onChange={(v) => setSection(s.id, { rule: v === "required" ? "COMPULSORY" : "OPTIONAL", ruleCount: undefined })}
                      options={[
                        { value: "required", label: "Required" },
                        { value: "optional", label: "Optional" },
                      ]}
                      ariaLabel="Required or optional"
                    />
                  </Field>
                  <Field label="Attempt rule">
                    <SelectField
                      value={s.rule}
                      onChange={(v) => setSection(s.id, { rule: v as AttemptRuleKind, ruleCount: RULES_WITH_COUNT.includes(v as AttemptRuleKind) ? s.ruleCount ?? Math.max(1, count - 2) : undefined })}
                      options={rules.map((r) => ({ value: r, label: r === "COMPULSORY" ? "All compulsory" : ATTEMPT_RULE_LABEL[r] }))}
                      ariaLabel="Attempt rule"
                    />
                  </Field>
                  <Field label="N" error={errors[`s-${s.id}-n`]}>
                    <Input
                      type="number"
                      min={1}
                      value={s.ruleCount ?? ""}
                      disabled={!RULES_WITH_COUNT.includes(s.rule)}
                      onChange={(e) => setSection(s.id, { ruleCount: Number(e.target.value) || undefined })}
                      aria-label="N"
                    />
                  </Field>
                  <Field label="Marks" error={errors[`s-${s.id}-marks`]}>
                    <Input type="number" min={0} value={s.marks} onChange={(e) => setSection(s.id, { marks: Number(e.target.value) })} aria-label="Section marks" />
                  </Field>
                  <div className="lg:pt-6">
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove ${s.name}`} onClick={() => removeSection(s)}>
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className={cn("rounded-md px-2 py-0.5 font-medium", required ? "bg-muted" : "bg-accent text-accent-foreground")}>
                    {required ? "Required" : "Optional"} · {ruleText(s, count)}
                  </span>
                  <span className="text-muted-foreground">{count} question{count === 1 ? "" : "s"} in this section</span>
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Info className="size-3" aria-hidden /> {RULE_HELP[s.rule]}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex items-center justify-between rounded-lg bg-muted/60 px-4 py-2.5 text-sm">
          <span>
            {totals.sections} sections · {totals.questions} questions
          </span>
          <span className="font-semibold tabular-nums">Total {totals.marks} marks</span>
        </div>
      </Panel>
    </div>
  );
}
