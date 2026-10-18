"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, CircleCheck, Layers, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { ConfirmDialog, Field, SelectField, Stepper } from "@/components/proto/controls";
import { EmptyState, PageHeader, Panel } from "@/components/proto/page";
import { PaperStats, PaperStructure } from "@/components/proto/paper-summary";
import { StatusBadge, Tag } from "@/components/proto/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ATTEMPT_RULE_LABEL, attemptRuleText, paperUsageLabel } from "@/lib/papers/rules";
import { toViewPaper } from "@/lib/papers/view-adapter";
import { QUESTION_TYPES } from "@/lib/questions/types";
import { useToast } from "@/prototype/toast";
import {
  addSectionAction,
  importIntoPaperAction,
  removeItemAction,
  removeSectionAction,
  reorderItemsAction,
  reorderSectionsAction,
  updatePaperAction,
  updateSectionAction,
} from "@/server/actions/question-papers";
import type { PaperGroupItem, PaperQuestionItem, QuestionPaperDetail } from "@/server/services/question-papers";
import { ImportIssues, ImportUpload, STEPS } from "../../new/new-paper-view";
import { MaterialsEditor } from "./materials-editor";
import { GroupDialog, QuestionDialog, type GroupTarget, type QuestionTarget } from "./question-dialogs";

export type EditorStep = "details" | "review" | "finish";
const STEP_INDEX: Record<EditorStep, number> = { details: 1, review: 2, finish: 3 };
const STEP_KEY = ["details", "details", "review", "finish"] as const;
type FieldErrors = Record<string, string[] | undefined>;
type Section = QuestionPaperDetail["sections"][number];
type ActionResult = { ok: boolean; error?: string; fieldErrors?: FieldErrors };

/** Run a server action with a toast for the outcome. */
function useRunner() {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const run = (action: () => Promise<ActionResult>, success?: [string, string?], after?: () => void) =>
    startTransition(async () => {
      const result = await action();
      if (!result.ok) return toast.error("That didn’t work", result.error);
      if (success) toast.success(...success);
      after?.();
    });
  return { run, pending };
}

const move = <T,>(list: T[], i: number, d: -1 | 1) => {
  const next = [...list];
  [next[i], next[i + d]] = [next[i + d], next[i]];
  return next;
};

// ---------------------------------------------------------------------------
// Step 1: paper details + structure
// ---------------------------------------------------------------------------

function DetailsForm({ paper }: { paper: QuestionPaperDetail }) {
  const toast = useToast();
  const [v, setV] = useState({
    name: paper.name,
    subject: paper.subject ?? "",
    durationMinutes: paper.durationMinutes ? String(paper.durationMinutes) : "",
    description: paper.description ?? "",
    instructions: paper.instructions ?? "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, startTransition] = useTransition();
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));

  function save() {
    startTransition(async () => {
      const result = await updatePaperAction(paper.id, v);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        if (!result.fieldErrors) toast.error("Couldn’t save the details", result.error);
        return;
      }
      setErrors({});
      toast.success("Paper details saved");
    });
  }

  return (
    <Panel title="Question paper details" actions={<Button size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save details"}</Button>}>
      <div className="grid gap-4">
        <Field label="Question paper name" htmlFor="pname" required error={errors.name?.[0]}>
          <Input id="pname" value={v.name} onChange={(e) => set({ name: e.target.value })} aria-invalid={!!errors.name || undefined} />
        </Field>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Course" hint="Fixed once the paper is created.">
            <Input value={`${paper.course.name} (${paper.course.code})`} readOnly disabled />
          </Field>
          <Field label="Subject" htmlFor="psub" error={errors.subject?.[0]}>
            <Input id="psub" value={v.subject} onChange={(e) => set({ subject: e.target.value })} />
          </Field>
          <Field label="Suggested duration" htmlFor="pdur" hint="Minutes" error={errors.durationMinutes?.[0]}>
            <Input id="pdur" type="number" min={1} value={v.durationMinutes} onChange={(e) => set({ durationMinutes: e.target.value })} />
          </Field>
        </div>
        <Field label="Description" htmlFor="pdesc" error={errors.description?.[0]}>
          <Textarea id="pdesc" rows={2} value={v.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <Field label="Instructions for learners" htmlFor="pinstr" error={errors.instructions?.[0]}>
          <Textarea id="pinstr" rows={3} value={v.instructions} onChange={(e) => set({ instructions: e.target.value })} />
        </Field>
      </div>
    </Panel>
  );
}

const RULES = ["ALL", "ANY_N", "EXACTLY_N", "UP_TO_N", "BEST_N"] as const;

function SectionCard({ paperId, section, index, count, onMove, onRemove }: { paperId: string; section: Section; index: number; count: number; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({
    title: section.title,
    instructions: section.instructions ?? "",
    isRequired: section.isRequired,
    attemptRule: section.attemptRule as string,
    attemptCount: section.attemptCount ? String(section.attemptCount) : "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, startTransition] = useTransition();
  const dirty =
    v.title !== section.title ||
    v.instructions !== (section.instructions ?? "") ||
    v.isRequired !== section.isRequired ||
    v.attemptRule !== section.attemptRule ||
    v.attemptCount !== (section.attemptCount ? String(section.attemptCount) : "");

  function save() {
    startTransition(async () => {
      const result = await updateSectionAction(paperId, section.id, { ...v, attemptCount: v.attemptRule === "ALL" ? "" : v.attemptCount });
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        if (!result.fieldErrors) toast.error("Couldn’t save the section", result.error);
        return;
      }
      setErrors({});
      toast.success("Section saved", v.title);
    });
  }

  return (
    <div className="rounded-lg border p-4">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_8rem_minmax(0,1.3fr)_5rem_auto] lg:items-start">
        <Field label="Section title" error={errors.title?.[0]}>
          <Input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} aria-label="Section title" />
        </Field>
        <Field label="Requirement">
          <SelectField
            value={v.isRequired ? "required" : "optional"}
            onChange={(x) => setV({ ...v, isRequired: x === "required" })}
            options={[
              { value: "required", label: "Required" },
              { value: "optional", label: "Optional" },
            ]}
            ariaLabel="Required or optional"
          />
        </Field>
        <Field label="Attempt rule">
          <SelectField value={v.attemptRule} onChange={(x) => setV({ ...v, attemptRule: x, attemptCount: x === "ALL" ? "" : v.attemptCount || "1" })} options={RULES.map((r) => ({ value: r, label: ATTEMPT_RULE_LABEL[r] }))} ariaLabel="Attempt rule" />
        </Field>
        <Field label="N" error={errors.attemptCount?.[0]}>
          <Input type="number" min={1} value={v.attemptCount} disabled={v.attemptRule === "ALL"} onChange={(e) => setV({ ...v, attemptCount: e.target.value })} aria-label="N" />
        </Field>
        <div className="flex gap-1 lg:pt-6">
          <Button variant="ghost" size="icon-sm" aria-label={`Move ${section.title} up`} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Move ${section.title} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${section.title}`} onClick={onRemove}>
            <Trash2 />
          </Button>
        </div>
      </div>
      <Field label="Section instructions (optional)" className="mt-3">
        <Input value={v.instructions} onChange={(e) => setV({ ...v, instructions: e.target.value })} aria-label="Section instructions" />
      </Field>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-muted px-2 py-0.5 font-medium">
            {section.isRequired ? "Required" : "Optional"} · {attemptRuleText(section.attemptRule, section.attemptCount, section.itemCount)}
          </span>
          <span className="text-muted-foreground">
            {section.itemCount} item{section.itemCount === 1 ? "" : "s"} · {section.maxMarks} marks counted
          </span>
        </span>
        <Button size="sm" variant={dirty ? "default" : "outline"} onClick={save} disabled={!dirty || pending}>
          {pending ? "Saving…" : "Save section"}
        </Button>
      </div>
    </div>
  );
}

function StructureStep({ paper }: { paper: QuestionPaperDetail }) {
  const { run, pending } = useRunner();
  const [removing, setRemoving] = useState<Section | null>(null);
  const nextLetter = String.fromCharCode(65 + paper.sections.length);

  return (
    <div className="grid gap-6">
      <DetailsForm paper={paper} />
      <Panel
        title="Question paper structure"
        description="Sections, how learners must attempt them, and the marks each counts towards the total."
        actions={
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => addSectionAction(paper.id, { title: `Section ${nextLetter}` }), [`Section ${nextLetter} added`])}>
            <Plus /> Add Section
          </Button>
        }
      >
        {paper.sections.length === 0 ? (
          <EmptyState icon={Layers} title="No sections yet" description="Add a section, then add questions to it in the next step." />
        ) : (
          <div className="grid gap-3">
            {paper.sections.map((s, i) => (
              <SectionCard
                key={`${s.id}-${s.title}-${s.attemptRule}-${s.attemptCount}-${s.isRequired}-${s.instructions}`}
                paperId={paper.id}
                section={s}
                index={i}
                count={paper.sections.length}
                onMove={(d) => run(() => reorderSectionsAction(paper.id, move(paper.sections, i, d).map((x) => x.id)), ["Sections reordered"])}
                onRemove={() => setRemoving(s)}
              />
            ))}
          </div>
        )}
        <div className="mt-4 flex items-center justify-between rounded-lg bg-muted/60 px-4 py-2.5 text-sm">
          <span>
            {paper.sections.length} sections · {paper.questionCount} questions
          </span>
          <span className="font-semibold tabular-nums">Total {paper.totalMarks} marks</span>
        </div>
      </Panel>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.title}?`}
        description={removing?.itemCount ? `Its ${removing.itemCount} item(s) are removed from this paper too (the questions stay in the question bank).` : "This section has no questions."}
        confirmLabel="Remove section"
        destructive
        onConfirm={() => removing && run(() => removeSectionAction(paper.id, removing.id), ["Section removed"])}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: review & edit questions
// ---------------------------------------------------------------------------

function QuestionRow({
  paperId,
  item,
  index,
  siblings,
  onEdit,
  onMove,
  onDelete,
}: {
  paperId: string;
  item: PaperQuestionItem;
  index: number;
  siblings: number;
  onEdit: () => void;
  onMove: (d: -1 | 1) => void;
  onDelete: () => void;
}) {
  const q = item.question;
  const correct = q.options.filter((o) => o.isCorrect).map((o) => String.fromCharCode(65 + q.options.indexOf(o)));
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="w-12 shrink-0 text-sm font-semibold tabular-nums">Q{item.number}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag>{QUESTION_TYPES[q.type].label}</Tag>
          <span className="text-xs text-muted-foreground">
            {item.marks} mark{item.marks === 1 ? "" : "s"}
            {item.negativeMarks ? ` · −${item.negativeMarks}` : ""}
            {correct.length ? ` · answer ${correct.join(", ")}` : ""}
            {q.topic ? ` · ${q.topic}` : ""}
          </span>
        </div>
        <p className="mt-1 text-sm whitespace-pre-line">{q.text}</p>
        {q.options.length ? (
          <ol className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
            {q.options.map((o, i) => (
              <li key={o.id} className={o.isCorrect ? "font-medium text-emerald-700" : undefined}>
                {String.fromCharCode(65 + i)}. {o.text}
              </li>
            ))}
          </ol>
        ) : null}
        {item.response.type !== "TEXT" ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Learners answer with {item.response.type === "FILE" ? "a file" : "text and a file"} ({item.response.allowedFileTypes.map((e) => `.${e}`).join(", ")}, up to {item.response.maxFileSizeMb} MB
            {item.response.fileRequired ? ", required" : ", optional"})
          </p>
        ) : null}
        <MaterialsEditor paperId={paperId} itemId={item.id} label={`Q${item.number}`} materials={item.materials} />
      </div>
      <div className="flex shrink-0 gap-0.5">
        <Button variant="ghost" size="icon-sm" aria-label={`Move Q${item.number} up`} disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Move Q${item.number} down`} disabled={index === siblings - 1} onClick={() => onMove(1)}>
          <ArrowDown />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Edit Q${item.number}`} onClick={onEdit}>
          <Pencil />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Delete Q${item.number}`} onClick={onDelete}>
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

function ImportMoreDialog({ paperId, onClose }: { paperId: string; onClose: () => void }) {
  const toast = useToast();
  const [parsed, setParsed] = useState<Parameters<Parameters<typeof ImportUpload>[0]["onParsed"]>[0]>(null);
  const [rowErrors, setRowErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ready = parsed && parsed.preview.issues.length === 0 && parsed.preview.summary.questions > 0;

  function save() {
    if (!parsed) return;
    startTransition(async () => {
      const result = await importIntoPaperAction(paperId, parsed.file);
      if (!result.ok) {
        setRowErrors(result.fieldErrors?.rows ?? Object.entries(result.fieldErrors ?? {}).flatMap(([k, m]) => (m ?? []).map((x) => `${k}: ${x}`)));
        setError(result.error ?? null);
        return;
      }
      toast.success(`${result.data!.questionsAdded} questions imported`, `${result.data!.sectionsCreated} new section(s).`);
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import more questions</DialogTitle>
          <DialogDescription>Upload the template (CSV). Questions go into sections with the same title, or new sections at the end. All or nothing.</DialogDescription>
        </DialogHeader>
        <ImportUpload method="excel" preview={parsed?.preview ?? null} onParsed={setParsed} />
        <ImportIssues issues={rowErrors} />
        {error && !rowErrors.length ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!ready || pending}>
            {pending ? "Importing…" : `Import ${parsed?.preview.summary.questions ?? ""} questions`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewStep({ paper }: { paper: QuestionPaperDetail }) {
  const { run } = useRunner();
  const [questionTarget, setQuestionTarget] = useState<QuestionTarget | null>(null);
  const [groupTarget, setGroupTarget] = useState<GroupTarget | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; label: string; hasChildren: boolean } | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const editQuestion = (item: PaperQuestionItem) =>
    setQuestionTarget({ mode: "edit", itemId: item.id, number: item.number, question: item.question, marks: item.marks, negativeMarks: item.negativeMarks, response: item.response });
  const reorder = (section: Section, parentId: string | null, ids: string[]) => run(() => reorderItemsAction(paper.id, section.id, parentId, ids), ["Order saved"]);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {paper.questionCount} questions in {paper.sections.length} sections · {paper.totalMarks} marks counted
        </p>
        <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
          <Upload /> Import more (CSV)
        </Button>
      </div>
      {paper.sections.length === 0 ? (
        <EmptyState icon={Layers} title="Add a section first" description="Questions belong to sections." action={<Link href="?step=details" className={buttonVariants()}>Go to structure</Link>} />
      ) : null}
      {paper.sections.map((s) => (
        <Panel
          key={s.id}
          title={s.title}
          description={`${s.isRequired ? "Required" : "Optional"} · ${attemptRuleText(s.attemptRule, s.attemptCount, s.itemCount)} · ${s.maxMarks} marks`}
          actions={
            <>
              <Button size="sm" variant="outline" onClick={() => setGroupTarget({ mode: "add", sectionId: s.id, sectionTitle: s.title })}>
                <Plus /> Case / passage
              </Button>
              <Button size="sm" onClick={() => setQuestionTarget({ mode: "add", sectionId: s.id, sectionTitle: s.title })}>
                <Plus /> Question
              </Button>
            </>
          }
        >
          {s.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No questions in this section yet.</p>
          ) : (
            <ul className="divide-y">
              {s.items.map((item, i) =>
                item.kind === "question" ? (
                  <QuestionRow
                    paperId={paper.id}
                    key={item.id}
                    item={item}
                    index={i}
                    siblings={s.items.length}
                    onEdit={() => editQuestion(item)}
                    onMove={(d) => reorder(s, null, move(s.items, i, d).map((x) => x.id))}
                    onDelete={() => setDeleting({ id: item.id, label: `Q${item.number}`, hasChildren: false })}
                  />
                ) : (
                  <GroupBlock
                    paperId={paper.id}
                    key={item.id}
                    group={item}
                    index={i}
                    siblings={s.items.length}
                    onEdit={() => setGroupTarget({ mode: "edit", itemId: item.id, number: item.number, groupType: item.groupType, text: item.text, passage: item.passage })}
                    onAddPart={() => setQuestionTarget({ mode: "add", sectionId: s.id, sectionTitle: s.title, parentId: item.id, parentLabel: `Q${item.number}` })}
                    onMove={(d) => reorder(s, null, move(s.items, i, d).map((x) => x.id))}
                    onDelete={() => setDeleting({ id: item.id, label: `Q${item.number}`, hasChildren: item.children.length > 0 })}
                    onEditChild={editQuestion}
                    onMoveChild={(ci, d) => reorder(s, item.id, move(item.children, ci, d).map((x) => x.id))}
                    onDeleteChild={(c) => setDeleting({ id: c.id, label: `Q${c.number}`, hasChildren: false })}
                  />
                ),
              )}
            </ul>
          )}
        </Panel>
      ))}

      {questionTarget ? <QuestionDialog paperId={paper.id} target={questionTarget} onClose={() => setQuestionTarget(null)} /> : null}
      {groupTarget ? <GroupDialog paperId={paper.id} target={groupTarget} onClose={() => setGroupTarget(null)} /> : null}
      {importOpen ? <ImportMoreDialog paperId={paper.id} onClose={() => setImportOpen(false)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.label}?`}
        description={deleting?.hasChildren ? "Its sub-questions are removed from the paper too." : "The question is removed from this paper (it stays in the question bank)."}
        confirmLabel="Delete"
        destructive
        onConfirm={() => deleting && run(() => removeItemAction(paper.id, deleting.id), [`${deleting.label} deleted`])}
      />
    </div>
  );
}

function GroupBlock({
  paperId,
  group,
  index,
  siblings,
  onEdit,
  onAddPart,
  onMove,
  onDelete,
  onEditChild,
  onMoveChild,
  onDeleteChild,
}: {
  paperId: string;
  group: PaperGroupItem;
  index: number;
  siblings: number;
  onEdit: () => void;
  onAddPart: () => void;
  onMove: (d: -1 | 1) => void;
  onDelete: () => void;
  onEditChild: (c: PaperQuestionItem) => void;
  onMoveChild: (i: number, d: -1 | 1) => void;
  onDeleteChild: (c: PaperQuestionItem) => void;
}) {
  return (
    <li className="py-3">
      <div className="flex items-start gap-3">
        <span className="w-12 shrink-0 text-sm font-semibold tabular-nums">Q{group.number}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Tag>{group.groupType === "CASE_STUDY" ? "Case study" : "Comprehension"}</Tag>
            <span className="text-xs text-muted-foreground">{group.marks} marks across {group.children.length} part{group.children.length === 1 ? "" : "s"}</span>
          </div>
          <p className="mt-1 text-sm font-medium">{group.text}</p>
          {group.passage ? <p className="mt-1 line-clamp-3 rounded-md bg-muted/60 px-3 py-2 text-xs whitespace-pre-line text-muted-foreground">{group.passage}</p> : null}
          <MaterialsEditor paperId={paperId} itemId={group.id} label={`Q${group.number}`} materials={group.materials} />
        </div>
        <div className="flex shrink-0 gap-0.5">
          <Button variant="ghost" size="icon-sm" aria-label={`Move Q${group.number} up`} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Move Q${group.number} down`} disabled={index === siblings - 1} onClick={() => onMove(1)}>
            <ArrowDown />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Edit Q${group.number}`} onClick={onEdit}>
            <Pencil />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Delete Q${group.number}`} onClick={onDelete}>
            <Trash2 />
          </Button>
        </div>
      </div>
      <ul className="mt-2 ml-12 divide-y border-l pl-4">
        {group.children.map((c, ci) => (
          <QuestionRow paperId={paperId} key={c.id} item={c} index={ci} siblings={group.children.length} onEdit={() => onEditChild(c)} onMove={(d) => onMoveChild(ci, d)} onDelete={() => onDeleteChild(c)} />
        ))}
        {group.children.length === 0 ? <li className="py-2 text-xs text-amber-700">Add at least one sub-question.</li> : null}
      </ul>
      <Button variant="ghost" size="sm" className="mt-1 ml-12" onClick={onAddPart}>
        <Plus /> Add sub-question
      </Button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Step 3: finish — every change is already saved; a complete paper is usable straight away
// ---------------------------------------------------------------------------

function FinishStep({ paper }: { paper: QuestionPaperDetail }) {
  const router = useRouter();
  const view = toViewPaper(paper);
  const ready = paper.issues.length === 0;

  return (
    <div className="grid gap-6">
      <Panel title="Ready to use?" description="Your changes are saved as you make them. A complete paper can be selected in the Assessment Builder straight away — no review or approval is needed.">
        {ready ? (
          <p className="flex items-center gap-2 text-sm text-emerald-700">
            <CircleCheck className="size-4" /> Complete — this paper can be selected when creating an assessment.
          </p>
        ) : (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
            <p className="flex items-center gap-2 font-medium">
              <AlertTriangle className="size-4" /> Saved, but not usable in an assessment until these are fixed:
            </p>
            <ul className="mt-1 list-disc pl-6">
              {paper.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
      <Panel title="Summary">
        <PaperStats paper={view} />
        <PaperStructure paper={view} className="mt-4" />
      </Panel>
      <div className="flex justify-end">
        <Button onClick={() => router.push(`/admin/import-questions/${paper.id}`)}>
          <CircleCheck /> Save & finish
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function PaperEditor({ paper, step }: { paper: QuestionPaperDetail; step: EditorStep }) {
  const router = useRouter();
  const current = STEP_INDEX[step];
  const goTo = (i: number) => i > 0 && router.push(`/admin/import-questions/${paper.id}/edit?step=${STEP_KEY[i]}`);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Import Questions", href: "/admin/import-questions" }, { label: paper.name, href: `/admin/import-questions/${paper.id}` }, { label: "Edit" }]}
        title={paper.name}
        meta={<StatusBadge status={paperUsageLabel({ inUse: paper.inUse, ready: paper.issues.length === 0 })} />}
        description={`${paper.course.name} · v${paper.version}${paper.sourceFileName ? ` · imported from ${paper.sourceFileName}` : " · created manually"} · ${paper.questionCount} questions`}
      />
      <div className="mb-6 rounded-lg border bg-card px-4 py-3">
        <Stepper steps={STEPS} current={current} maxReached={3} onStepClick={goTo} />
      </div>

      {step === "details" ? <StructureStep paper={paper} /> : null}
      {step === "review" ? <ReviewStep paper={paper} /> : null}
      {step === "finish" ? <FinishStep paper={paper} /> : null}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <Link href={`/admin/import-questions/${paper.id}`} className={buttonVariants({ variant: "ghost" })}>
          Done for now
        </Link>
        <div className="flex gap-2">
          {current > 1 ? (
            <Button variant="outline" onClick={() => goTo(current - 1)}>
              Back
            </Button>
          ) : null}
          {current < 3 ? <Button onClick={() => goTo(current + 1)}>Next</Button> : null}
        </div>
      </div>
    </>
  );
}
