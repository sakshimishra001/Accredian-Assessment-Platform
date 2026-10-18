"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Field, SelectField } from "@/components/proto/controls";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ALL_QUESTION_TYPES, QUESTION_TYPES, hasOptions, type QuestionType } from "@/lib/questions/types";
import type { QuestionSnapshot } from "@/lib/questions/snapshot";
import { DEFAULT_ANSWER_TYPES, LEARNER_FILE_GROUPS, MAX_ANSWER_FILES, MAX_ANSWER_MB, RESPONSE_TYPE_LABEL } from "@/lib/files/types";
import type { PaperQuestionItem } from "@/server/services/question-papers";
import { useToast } from "@/prototype/toast";
import { addGroupAction, addQuestionAction, updateGroupAction, updateQuestionAction } from "@/server/actions/question-papers";

type FieldErrors = Record<string, string[] | undefined>;
const LETTERS = "ABCDEF";
const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;

export type QuestionTarget =
  | { mode: "add"; sectionId: string; sectionTitle: string; parentId?: string; parentLabel?: string }
  | { mode: "edit"; itemId: string; number: string; question: QuestionSnapshot; marks: number; negativeMarks: number; response: PaperQuestionItem["response"] };

type ResponseType = keyof typeof RESPONSE_TYPE_LABEL;

function initialOptions(type: QuestionType, existing?: QuestionSnapshot) {
  if (existing && existing.type === type && existing.options.length) return existing.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect }));
  if (type === "TRUE_FALSE") return [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }];
  if (hasOptions(type)) return Array.from({ length: 4 }, () => ({ text: "", isCorrect: false }));
  return [];
}

/** Add or edit one question. All checks (options, correct answer, marks) are done by the server. */
export function QuestionDialog({ paperId, target, onClose }: { paperId: string; target: QuestionTarget; onClose: () => void }) {
  const toast = useToast();
  const existing = target.mode === "edit" ? target.question : undefined;
  const [type, setType] = useState<QuestionType>(existing?.type ?? "MCQ_SINGLE");
  const [text, setText] = useState(existing?.text ?? "");
  const [options, setOptions] = useState(() => initialOptions(existing?.type ?? "MCQ_SINGLE", existing));
  const [marks, setMarks] = useState(String(target.mode === "edit" ? target.marks : 1));
  const [negativeMarks, setNegativeMarks] = useState(String(target.mode === "edit" ? target.negativeMarks : 0));
  const [topic, setTopic] = useState(existing?.topic ?? "");
  const [difficulty, setDifficulty] = useState<string>(existing?.difficulty ?? "MEDIUM");
  const [guidance, setGuidance] = useState(existing?.guidance ?? "");
  const existingResponse = target.mode === "edit" ? target.response : null;
  const [responseType, setResponseType] = useState<ResponseType>(existingResponse?.type ?? "TEXT");
  const [fileTypes, setFileTypes] = useState<string[]>(existingResponse?.allowedFileTypes.length ? existingResponse.allowedFileTypes : DEFAULT_ANSWER_TYPES);
  const [maxFileSizeMb, setMaxFileSizeMb] = useState(String(existingResponse?.maxFileSizeMb ?? 20));
  const [maxFiles, setMaxFiles] = useState(String(existingResponse?.maxFiles ?? 1));
  const [fileRequired, setFileRequired] = useState(existingResponse?.fileRequired ?? true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const objective = hasOptions(type);

  function changeType(t: QuestionType) {
    setType(t);
    setOptions(initialOptions(t, existing));
    if (!hasOptions(t)) setNegativeMarks("0");
  }

  function setCorrect(i: number, value: boolean) {
    setOptions((list) => list.map((o, j) => (type === "MCQ_MULTI" ? (j === i ? { ...o, isCorrect: value } : o) : { ...o, isCorrect: j === i ? value : false })));
  }

  function save() {
    setFormError(null);
    const response = objective ? undefined : { type: responseType, allowedFileTypes: fileTypes, maxFileSizeMb, maxFiles, fileRequired };
    const input = { type, text, options, marks, negativeMarks: objective ? negativeMarks : 0, topic, difficulty, guidance, response };
    startTransition(async () => {
      const result =
        target.mode === "edit" ? await updateQuestionAction(paperId, target.itemId, input) : await addQuestionAction(paperId, target.sectionId, input, target.parentId);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setFormError(result.fieldErrors ? null : result.error);
        return;
      }
      toast.success(target.mode === "edit" ? `Q${target.number} saved` : "Question added");
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{target.mode === "edit" ? `Edit Q${target.number}` : target.parentId ? `Add a part to ${target.parentLabel}` : `Add a question to ${target.sectionTitle}`}</DialogTitle>
          <DialogDescription>{target.mode === "edit" ? "Saving updates this paper’s copy; assessments keep the questions they were created with." : "The question is saved to the paper straight away."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_7rem_7rem]">
            <Field label="Question type" htmlFor="q-type">
              <SelectField id="q-type" value={type} onChange={(v) => changeType(v as QuestionType)} options={ALL_QUESTION_TYPES.map((t) => ({ value: t, label: QUESTION_TYPES[t].label }))} />
            </Field>
            <Field label="Marks" htmlFor="q-marks" error={errors.marks?.[0]}>
              <Input id="q-marks" type="number" min={0} step={0.25} value={marks} onChange={(e) => setMarks(e.target.value)} aria-invalid={!!errors.marks || undefined} />
            </Field>
            <Field label="Negative" htmlFor="q-neg" error={errors.negativeMarks?.[0]} hint={objective ? undefined : "Objective only"}>
              <Input id="q-neg" type="number" min={0} step={0.25} value={negativeMarks} disabled={!objective} onChange={(e) => setNegativeMarks(e.target.value)} />
            </Field>
          </div>
          <Field label="Question text" htmlFor="q-text" required error={errors.text?.[0]}>
            <Textarea id="q-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!!errors.text || undefined} />
          </Field>

          {objective ? (
            <Field label={type === "MCQ_MULTI" ? "Options — tick every correct answer" : "Options — choose the correct answer"} error={errors.options?.[0]}>
              <div className="grid gap-2" role="group" aria-label="Options">
                {options.map((o, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type={type === "MCQ_MULTI" ? "checkbox" : "radio"}
                      name="correct"
                      checked={o.isCorrect}
                      onChange={(e) => setCorrect(i, e.target.checked)}
                      className="size-4 accent-[var(--primary)]"
                      aria-label={`Option ${LETTERS[i]} is correct`}
                    />
                    <span className="w-4 text-sm font-medium text-muted-foreground">{LETTERS[i]}</span>
                    <Input
                      value={o.text}
                      disabled={type === "TRUE_FALSE"}
                      onChange={(e) => setOptions((list) => list.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                      aria-label={`Option ${LETTERS[i]}`}
                    />
                    {type !== "TRUE_FALSE" ? (
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove option ${LETTERS[i]}`} disabled={options.length <= 2} onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}>
                        <Trash2 />
                      </Button>
                    ) : null}
                  </div>
                ))}
                {type !== "TRUE_FALSE" && options.length < LETTERS.length ? (
                  <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setOptions((list) => [...list, { text: "", isCorrect: false }])}>
                    <Plus /> Add option
                  </Button>
                ) : null}
              </div>
            </Field>
          ) : null}

          {!objective ? (
            <fieldset className="grid gap-3 rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">Learner response</legend>
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Learner response">
                {(Object.keys(RESPONSE_TYPE_LABEL) as ResponseType[]).map((r) => (
                  <label key={r} className="flex items-center gap-2 text-sm">
                    <input type="radio" name="response-type" checked={responseType === r} onChange={() => setResponseType(r)} className="accent-[var(--primary)]" />
                    {RESPONSE_TYPE_LABEL[r]}
                  </label>
                ))}
              </div>
              {responseType !== "TEXT" ? (
                <>
                  <Field label="Accepted file types" error={errors["response.allowedFileTypes"]?.[0]}>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {LEARNER_FILE_GROUPS.map((g) => (
                        <div key={g.label} className="text-xs">
                          <span className="mr-2 font-medium text-muted-foreground">{g.label}</span>
                          {g.exts.map((e) => (
                            <label key={e} className="mr-2 inline-flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={fileTypes.includes(e)}
                                onChange={(ev) => setFileTypes((list) => (ev.target.checked ? [...list, e] : list.filter((x) => x !== e)))}
                                aria-label={`Accept .${e}`}
                              />
                              .{e}
                            </label>
                          ))}
                        </div>
                      ))}
                    </div>
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
                    <Field label="Max size (MB)" htmlFor="q-maxmb" error={errors["response.maxFileSizeMb"]?.[0]}>
                      <Input id="q-maxmb" type="number" min={1} max={MAX_ANSWER_MB} value={maxFileSizeMb} onChange={(e) => setMaxFileSizeMb(e.target.value)} />
                    </Field>
                    <Field label="Max files" htmlFor="q-maxfiles" error={errors["response.maxFiles"]?.[0]}>
                      <Input id="q-maxfiles" type="number" min={1} max={MAX_ANSWER_FILES} value={maxFiles} onChange={(e) => setMaxFiles(e.target.value)} />
                    </Field>
                    <label className="flex items-center gap-2 pb-2 text-sm">
                      <input type="checkbox" checked={fileRequired} onChange={(e) => setFileRequired(e.target.checked)} /> File required to submit
                    </label>
                  </div>
                </>
              ) : null}
            </fieldset>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Topic" htmlFor="q-topic" error={errors.topic?.[0]}>
              <Input id="q-topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
            </Field>
            <Field label="Difficulty" htmlFor="q-diff">
              <SelectField id="q-diff" value={difficulty} onChange={setDifficulty} options={DIFFICULTIES.map((d) => ({ value: d, label: d[0] + d.slice(1).toLowerCase() }))} />
            </Field>
          </div>
          <Field label={objective ? "Explanation (optional)" : "Model answer / marking guidance (optional)"} htmlFor="q-guidance" hint="Visible to proctors and examiners, not to learners." error={errors.guidance?.[0]}>
            <Textarea id="q-guidance" rows={2} value={guidance} onChange={(e) => setGuidance(e.target.value)} />
          </Field>
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : target.mode === "edit" ? "Save question" : "Add question"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type GroupTarget =
  | { mode: "add"; sectionId: string; sectionTitle: string }
  | { mode: "edit"; itemId: string; number: string; groupType: "CASE_STUDY" | "COMPREHENSION"; text: string; passage: string | null };

/** Add or edit a case study / comprehension: its title/prompt and the shared passage. */
export function GroupDialog({ paperId, target, onClose }: { paperId: string; target: GroupTarget; onClose: () => void }) {
  const toast = useToast();
  const [groupType, setGroupType] = useState<string>(target.mode === "edit" ? target.groupType : "CASE_STUDY");
  const [text, setText] = useState(target.mode === "edit" ? target.text : "");
  const [passage, setPassage] = useState(target.mode === "edit" ? (target.passage ?? "") : "");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setFormError(null);
    const input = { groupType, text, passage };
    startTransition(async () => {
      const result = target.mode === "edit" ? await updateGroupAction(paperId, target.itemId, input) : await addGroupAction(paperId, target.sectionId, input);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setFormError(result.fieldErrors ? null : result.error);
        return;
      }
      toast.success(target.mode === "edit" ? `Q${target.number} saved` : "Case / passage added", target.mode === "add" ? "Add its sub-questions next." : undefined);
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{target.mode === "edit" ? `Edit Q${target.number}` : `Add a case study or passage to ${target.sectionTitle}`}</DialogTitle>
          <DialogDescription>Learners see the passage first, then its sub-questions.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Kind" htmlFor="g-type" error={errors.groupType?.[0]}>
            <SelectField
              id="g-type"
              value={groupType}
              onChange={setGroupType}
              options={[
                { value: "CASE_STUDY", label: "Case study" },
                { value: "COMPREHENSION", label: "Comprehension" },
              ]}
            />
          </Field>
          <Field label="Title / prompt" htmlFor="g-text" required error={errors.text?.[0]}>
            <Input id="g-text" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!!errors.text || undefined} />
          </Field>
          <Field label="Passage / case text" htmlFor="g-passage" error={errors.passage?.[0]}>
            <Textarea id="g-passage" rows={6} value={passage} onChange={(e) => setPassage(e.target.value)} />
          </Field>
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : target.mode === "edit" ? "Save" : "Add case / passage"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
