"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CircleCheck, Paperclip, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  QUESTION_TYPE_LABEL,
  QUESTION_TYPES,
  countWhere,
  findQuestion,
  hasOptions,
  isGroupType,
  mapQuestions,
  paperTotals,
  questionIssues,
  ruleText,
  sectionQuestions,
} from "@/prototype/lib/paper";
import { newId } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { Question, QuestionPaper, QuestionType } from "@/prototype/types";
import { ConfirmDialog, Field, SelectField } from "../controls";
import { AddMaterialDialog, MaterialList } from "../materials";
import { ResponseConfigEditor, responseSummary } from "../response-config";
import { hasConfigurableResponse } from "@/prototype/lib/response";
import { Panel } from "../page";
import { QuestionView } from "../question-view";
import { Tag } from "../status-badge";

const sub = (n: number) => String.fromCharCode(97 + n);

function blankOptions(type: QuestionType) {
  if (type === "TRUE_FALSE") return [
    { id: newId("o"), text: "True", correct: false },
    { id: newId("o"), text: "False", correct: false },
  ];
  if (hasOptions(type)) return Array.from({ length: 4 }, () => ({ id: newId("o"), text: "", correct: false }));
  return [];
}

function allIssues(q: Question): string[] {
  return [...questionIssues(q), ...q.children.flatMap((c) => questionIssues(c).map((i) => `Q${c.number}: ${i}`))];
}

export function ReviewStep({
  paper,
  onChange,
  initialFilter = "all",
}: {
  paper: QuestionPaper;
  onChange: (p: QuestionPaper) => void;
  initialFilter?: "all" | "review";
}) {
  const toast = useToast();
  const [filter, setFilter] = useState<"all" | "review">(initialFilter);
  const firstFlagged = useMemo(() => paper.questions.flatMap((q) => [q, ...q.children]).find((q) => q.needsReview)?.id, [paper.questions]);
  const [chosenId, setSelectedId] = useState<string>(firstFlagged ?? paper.questions[0]?.id ?? "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Question | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addingMaterial, setAddingMaterial] = useState(false);
  const totals = paperTotals(paper);
  // Fall back to the first question if the chosen one was deleted.
  const selectedId = findQuestion(paper.questions, chosenId) ? chosenId : (paper.questions[0]?.id ?? "");
  const selected = findQuestion(paper.questions, selectedId);
  const isChild = selected ? !paper.questions.some((q) => q.id === selected.id) : false;

  const replace = (q: Question) => onChange({ ...paper, questions: mapQuestions(paper.questions, (x) => (x.id === q.id ? { ...q, children: q.children } : x)) });

  function startEdit() {
    if (!selected) return;
    setDraft(structuredClone(selected));
    setEditing(true);
  }

  function save() {
    if (!draft) return;
    replace(draft);
    setEditing(false);
    // Only speak up when something still needs fixing; a clean save is visible in the panel itself.
    if (allIssues(draft).length) toast.info(`Q${draft.number} saved with open issues`, "Resolve them before marking as reviewed.");
  }

  function markReviewed() {
    if (!selected) return;
    const issues = allIssues(selected);
    if (issues.length) {
      toast.error(`Q${selected.number} still has issues`, issues.join(" · "));
      return;
    }
    const cleared = { ...selected, needsReview: false, reviewNote: undefined, children: selected.children.map((c) => ({ ...c, needsReview: false })) };
    const nextPaper = { ...paper, questions: mapQuestions(paper.questions, (x) => (x.id === cleared.id ? cleared : x)) };
    onChange(nextPaper);
    const remaining = countWhere(nextPaper.questions, (x) => x.needsReview);
    toast.success(`Q${selected.number} marked as reviewed`, remaining ? `${remaining} question${remaining === 1 ? "" : "s"} still need review.` : "All flagged questions are resolved.");
    const next = nextPaper.questions.flatMap((q) => [q, ...q.children]).find((q) => q.needsReview);
    if (next) setSelectedId(next.id);
  }

  function addQuestion(sectionId: string) {
    const max = Math.max(0, ...paper.questions.map((q) => Number.parseInt(q.number, 10) || 0));
    const q: Question = {
      id: newId("q"),
      number: String(max + 1),
      type: "MCQ_SINGLE",
      text: "",
      options: blankOptions("MCQ_SINGLE"),
      marks: 1,
      sectionId,
      compulsory: true,
      needsReview: true,
      reviewNote: "New question — complete the details.",
      children: [],
    };
    const lastIndex = paper.questions.map((x) => x.sectionId).lastIndexOf(sectionId);
    const questions = [...paper.questions];
    questions.splice(lastIndex + 1, 0, q);
    onChange({ ...paper, questions });
    setSelectedId(q.id);
    setDraft(structuredClone(q));
    setEditing(true);
  }

  function deleteSelected() {
    if (!selected) return;
    const questions = isChild
      ? mapQuestions(paper.questions, (x) => ({ ...x, children: x.children.filter((c) => c.id !== selected.id) }))
      : paper.questions.filter((q) => q.id !== selected.id);
    onChange({ ...paper, questions });
    setEditing(false);
    setSelectedId(questions[0]?.id ?? "");
    toast.success(`Q${selected.number} deleted`);
  }

  const visible = (q: Question) => filter === "all" || q.needsReview || q.children.some((c) => c.needsReview);

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          [totals.questions, "Questions"],
          [totals.objective, "Objective"],
          [totals.subjective, "Subjective"],
          [totals.sections, "Sections"],
          [totals.needsReview, "Need review"],
        ].map(([v, l]) => (
          <div key={String(l)} className={cn("rounded-lg border bg-card px-3 py-2", l === "Need review" && Number(v) > 0 && "border-amber-300 bg-amber-50")}>
            <div className="text-xs text-muted-foreground">{l}</div>
            <div className="text-lg font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <Panel bodyClassName="p-0" className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-7rem)] lg:overflow-hidden">
          <div className="flex gap-1 border-b p-2" role="tablist" aria-label="Question filter">
            {(
              [
                ["all", `All (${totals.questions})`],
                ["review", `Needs review (${totals.needsReview})`],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={filter === k}
                onClick={() => setFilter(k)}
                className={cn("flex-1 rounded-md px-2 py-1 text-xs font-medium", filter === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
              >
                {l}
              </button>
            ))}
          </div>
          <div className="max-h-[60vh] overflow-y-auto lg:max-h-[calc(100vh-11rem)]">
            {paper.sections.map((s) => {
              const qs = paper.questions.filter((q) => q.sectionId === s.id).filter(visible);
              if (filter === "review" && qs.length === 0) return null;
              return (
                <div key={s.id} className="border-b last:border-b-0">
                  <div className="flex items-center justify-between bg-muted/50 px-3 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    <span className="truncate">{s.name}</span>
                    <button type="button" onClick={() => addQuestion(s.id)} className="rounded p-0.5 hover:bg-background hover:text-foreground" aria-label={`Add question to ${s.name}`} title="Add question">
                      <Plus className="size-3.5" />
                    </button>
                  </div>
                  <ul>
                    {qs.map((q) => (
                      <li key={q.id}>
                        <QuestionListItem q={q} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setEditing(false); }} />
                        {q.children.map((c) => (
                          <QuestionListItem key={c.id} q={c} child selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setEditing(false); }} />
                        ))}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {filter === "review" && totals.needsReview === 0 ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">No questions need review.</p> : null}
          </div>
        </Panel>

        {selected ? (
          <Panel
            title={
              <span className="flex items-center gap-2">
                Q{selected.number}
                <Tag>{QUESTION_TYPE_LABEL[selected.type]}</Tag>
                {selected.needsReview ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                    <AlertTriangle className="size-3.5" /> Needs review
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                    <CircleCheck className="size-3.5" /> Valid
                  </span>
                )}
              </span>
            }
            description={paper.sections.find((s) => s.id === selected.sectionId)?.name}
            actions={
              editing ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={save}>
                    Save
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" size="icon-sm" aria-label="Delete question" onClick={() => setConfirmDelete(true)}>
                    <Trash2 />
                  </Button>
                  <Button variant="outline" size="sm" onClick={startEdit}>
                    <Pencil /> Edit Question
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setAddingMaterial(true)}>
                    <Paperclip /> Add Supporting Material
                  </Button>
                  <Button size="sm" onClick={markReviewed} disabled={!selected.needsReview && !selected.children.some((c) => c.needsReview)}>
                    <CircleCheck /> Mark as Reviewed
                  </Button>
                </>
              )
            }
          >
            {selected.needsReview && selected.reviewNote && !editing ? (
              <p className="mb-4 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {selected.reviewNote}
              </p>
            ) : null}
            {!editing ? (
              <div className="grid gap-5">
                <QuestionFacts q={selected} paper={paper} isChild={isChild} />
                <div>
                  <p className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Question</p>
                  <QuestionView q={selected} hideMaterials />
                </div>
                {allIssues(selected).length ? (
                  <ul className="grid gap-1 text-xs text-destructive">
                    {allIssues(selected).map((i) => (
                      <li key={i}>• {i}</li>
                    ))}
                  </ul>
                ) : null}
                <section aria-label="Supporting material">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Supporting material</p>
                    {selected.materials?.length ? (
                      <Button variant="ghost" size="xs" onClick={() => setAddingMaterial(true)}>
                        <Plus /> Add
                      </Button>
                    ) : null}
                  </div>
                  {selected.materials?.length ? (
                    <MaterialList materials={selected.materials} onRemove={(mid) => replace({ ...selected, materials: selected.materials!.filter((m) => m.id !== mid) })} />
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-3">
                      <span className="text-sm text-muted-foreground">No supporting material. Attach images, documents or datasets learners should consult.</span>
                      <Button variant="outline" size="sm" onClick={() => setAddingMaterial(true)}>
                        <Paperclip /> Add Supporting Material
                      </Button>
                    </div>
                  )}
                </section>
              </div>
            ) : draft ? (
              <QuestionEditor draft={draft} setDraft={setDraft} paper={paper} isChild={isChild} />
            ) : null}
          </Panel>
        ) : (
          <Panel>
            <p className="py-10 text-center text-sm text-muted-foreground">Select a question to review it.</p>
          </Panel>
        )}
      </div>

      <AddMaterialDialog
        open={addingMaterial}
        onOpenChange={setAddingMaterial}
        onAdd={(m) => {
          if (!selected) return;
          replace({ ...selected, materials: [...(selected.materials ?? []), m] });
          toast.success("Supporting material added", `${m.name} attached to Q${selected.number}.`);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete Q${selected?.number}?`}
        description={selected?.children.length ? `Its ${selected.children.length} sub-questions will be deleted too.` : "This removes the question from the paper."}
        confirmLabel="Delete question"
        destructive
        onConfirm={deleteSelected}
      />
    </div>
  );
}

function QuestionFacts({ q, paper, isChild }: { q: Question; paper: QuestionPaper; isChild: boolean }) {
  const section = paper.sections.find((s) => s.id === q.sectionId);
  const parent = isChild ? paper.questions.find((p) => p.children.some((c) => c.id === q.id)) : undefined;
  const required = (parent ?? q).compulsory;
  const facts: [string, React.ReactNode][] = [
    ["Question", `Q${q.number}${parent ? ` (part of Q${parent.number})` : ""}`],
    ["Type", QUESTION_TYPE_LABEL[q.type]],
    ["Section", section?.name ?? "—"],
    ["Marks", q.marks],
    ["Required", required ? "Required" : "Optional"],
    ["Attempt rule", section ? ruleText(section, sectionQuestions(paper, section.id).length) : "—"],
    ...(hasConfigurableResponse(q) ? ([["Learner response", responseSummary(q.response)]] as [string, React.ReactNode][]) : []),
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm md:grid-cols-3">
      {facts.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="truncate font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function QuestionListItem({ q, selectedId, onSelect, child }: { q: Question; selectedId: string; onSelect: (id: string) => void; child?: boolean }) {
  const flagged = q.needsReview || q.children.some((c) => c.needsReview);
  return (
    <button
      type="button"
      onClick={() => onSelect(q.id)}
      aria-current={selectedId === q.id ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 py-1.5 pr-3 text-left text-sm hover:bg-muted/70",
        child ? "pl-8" : "pl-3",
        selectedId === q.id && "bg-accent text-accent-foreground",
      )}
    >
      {flagged ? <AlertTriangle className="size-3.5 shrink-0 text-amber-600" aria-label="Needs review" /> : <CircleCheck className="size-3.5 shrink-0 text-emerald-600" aria-label="Valid" />}
      <span className="w-12 shrink-0 font-medium tabular-nums">Q{q.number}</span>
      <span className="truncate text-xs text-muted-foreground">{q.text || "Untitled question"}</span>
    </button>
  );
}

function QuestionEditor({ draft, setDraft, paper, isChild }: { draft: Question; setDraft: (q: Question) => void; paper: QuestionPaper; isChild: boolean }) {
  const set = (patch: Partial<Question>) => setDraft({ ...draft, ...patch });
  const multi = draft.type === "MCQ_MULTI";
  const issues = allIssues(draft);

  function changeType(type: QuestionType) {
    const keepOptions = hasOptions(type) && hasOptions(draft.type) && type !== "TRUE_FALSE" && draft.type !== "TRUE_FALSE";
    let options = keepOptions ? draft.options : blankOptions(type);
    if (type === "MCQ_SINGLE" && keepOptions) {
      const first = options.findIndex((o) => o.correct);
      options = options.map((o, i) => ({ ...o, correct: i === first }));
    }
    set({ type, options, passage: isGroupType(type) ? draft.passage ?? "" : undefined });
  }

  function setCorrect(id: string, checked: boolean) {
    set({ options: draft.options.map((o) => (multi ? (o.id === id ? { ...o, correct: checked } : o) : { ...o, correct: o.id === id })) });
  }

  function addChild() {
    const type: QuestionType = draft.type === "COMPREHENSION" ? "MCQ_SINGLE" : "SHORT_ANSWER";
    const child: Question = {
      id: newId("q"),
      number: `${draft.number}(${sub(draft.children.length)})`,
      type,
      text: "",
      options: blankOptions(type),
      marks: 1,
      sectionId: draft.sectionId,
      compulsory: draft.compulsory,
      needsReview: false,
      children: [],
    };
    set({ children: [...draft.children, child] });
  }

  const childTotal = draft.children.reduce((s, c) => s + c.marks, 0);

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Question type">
          <SelectField value={draft.type} onChange={(v) => changeType(v as QuestionType)} options={QUESTION_TYPES.filter((t) => !isChild || !isGroupType(t)).map((t) => ({ value: t, label: QUESTION_TYPE_LABEL[t] }))} ariaLabel="Question type" />
        </Field>
        <Field label="Marks" hint={draft.children.length ? `Parts total ${childTotal}` : undefined}>
          <Input type="number" min={0} step={0.5} value={draft.marks} onChange={(e) => set({ marks: Number(e.target.value) })} aria-label="Marks" />
        </Field>
        {!isChild ? (
          <Field label="Section">
            <SelectField value={draft.sectionId} onChange={(v) => set({ sectionId: v })} options={paper.sections.map((s) => ({ value: s.id, label: s.name }))} ariaLabel="Section" />
          </Field>
        ) : (
          <div />
        )}
      </div>

      {isGroupType(draft.type) ? (
        <Field label={draft.type === "CASE_STUDY" ? "Case text" : "Passage"}>
          <Textarea rows={5} value={draft.passage ?? ""} onChange={(e) => set({ passage: e.target.value })} />
        </Field>
      ) : null}

      <Field label="Question text">
        <Textarea rows={3} value={draft.text} onChange={(e) => set({ text: e.target.value })} aria-invalid={!draft.text.trim() || undefined} />
      </Field>

      {hasOptions(draft.type) ? (
        <Field label={multi ? "Options — tick every correct answer" : "Options — select the correct answer"}>
          <ul className="grid gap-2">
            {draft.options.map((o, i) => (
              <li key={o.id} className="flex items-center gap-2">
                <input
                  type={multi ? "checkbox" : "radio"}
                  name={`correct-${draft.id}`}
                  checked={o.correct}
                  onChange={(e) => setCorrect(o.id, e.target.checked)}
                  className="size-4 accent-[var(--primary)]"
                  aria-label={`Option ${String.fromCharCode(65 + i)} is correct`}
                />
                <span className="w-4 text-xs font-medium text-muted-foreground">{String.fromCharCode(65 + i)}</span>
                <Input
                  value={o.text}
                  disabled={draft.type === "TRUE_FALSE"}
                  onChange={(e) => set({ options: draft.options.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)) })}
                  aria-label={`Option ${String.fromCharCode(65 + i)}`}
                  aria-invalid={!o.text.trim() || undefined}
                />
                {draft.type !== "TRUE_FALSE" ? (
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove option ${String.fromCharCode(65 + i)}`} disabled={draft.options.length <= 2} onClick={() => set({ options: draft.options.filter((x) => x.id !== o.id) })}>
                    <Trash2 />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {draft.type !== "TRUE_FALSE" ? (
            <div>
              <Button variant="outline" size="sm" disabled={draft.options.length >= 6} onClick={() => set({ options: [...draft.options, { id: newId("o"), text: "", correct: false }] })}>
                <Plus /> Add option
              </Button>
            </div>
          ) : null}
        </Field>
      ) : null}

      {!isChild ? (
        <label className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
          <span>
            <span className="block text-sm font-medium">Compulsory</span>
            <span className="block text-xs text-muted-foreground">Optional questions follow the section’s attempt rule.</span>
          </span>
          <Switch checked={draft.compulsory} onCheckedChange={(v) => set({ compulsory: Boolean(v) })} />
        </label>
      ) : null}

      {hasConfigurableResponse(draft) ? <ResponseConfigEditor value={draft.response} onChange={(response) => set({ response })} /> : null}

      {!isChild ? (
        <div className="rounded-lg border">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-medium">{isGroupType(draft.type) ? "Questions in this group" : "Sub-questions"}</span>
            <Button variant="outline" size="xs" onClick={addChild}>
              <Plus /> {isGroupType(draft.type) ? "Add Question" : "Add Sub-question"}
            </Button>
          </div>
          {draft.children.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">No sub-questions. Add parts like {draft.number}(a), {draft.number}(b).</p>
          ) : (
            <ul className="divide-y">
              {draft.children.map((c) => (
                <li key={c.id} className="grid gap-2 border-l-2 border-primary/20 px-3 py-2.5 md:grid-cols-[4rem_10rem_1fr_5rem_auto] md:items-center">
                  <span className="text-sm font-medium tabular-nums">Q{c.number}</span>
                  <SelectField
                    value={c.type}
                    onChange={(v) => {
                      const type = v as QuestionType;
                      set({ children: draft.children.map((x) => (x.id === c.id ? { ...x, type, options: hasOptions(type) ? (hasOptions(x.type) && type !== "TRUE_FALSE" && x.type !== "TRUE_FALSE" ? x.options : blankOptions(type)) : [] } : x)) });
                    }}
                    options={QUESTION_TYPES.filter((t) => !isGroupType(t)).map((t) => ({ value: t, label: QUESTION_TYPE_LABEL[t] }))}
                    ariaLabel={`Type of Q${c.number}`}
                  />
                  <Input value={c.text} placeholder="Sub-question text" onChange={(e) => set({ children: draft.children.map((x) => (x.id === c.id ? { ...x, text: e.target.value } : x)) })} aria-label={`Text of Q${c.number}`} />
                  <Input type="number" min={0} step={0.5} value={c.marks} onChange={(e) => set({ children: draft.children.map((x) => (x.id === c.id ? { ...x, marks: Number(e.target.value) } : x)) })} aria-label={`Marks of Q${c.number}`} />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove Q${c.number}`}
                    onClick={() => set({ children: draft.children.filter((x) => x.id !== c.id).map((x, j) => ({ ...x, number: `${draft.number}(${sub(j)})` })) })}
                  >
                    <Trash2 />
                  </Button>
                  {hasOptions(c.type) ? <p className="text-xs text-muted-foreground md:col-span-5">Options for Q{c.number} can be edited after saving — select it in the list.</p> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {issues.length ? (
        <ul className="grid gap-1 rounded-md bg-red-50 px-3 py-2 text-xs text-destructive ring-1 ring-red-200 ring-inset">
          {issues.map((i) => (
            <li key={i}>• {i}</li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-emerald-700">
          <CircleCheck className="size-3.5" /> No issues found
        </p>
      )}
    </div>
  );
}
