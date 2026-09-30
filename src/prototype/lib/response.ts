// Learner response configuration and (mock) answer-completeness rules.

import type { AnswerAttachment, Question, ResponseConfig, ResponseType } from "../types";
import { hasOptions, isGroupType } from "./paper";

export const RESPONSE_TYPE_LABEL: Record<ResponseType, string> = {
  text: "Text Answer",
  file: "File Upload",
  text_file: "Text + File Upload",
};

/** File types a question can accept from learners, grouped for the admin picker. */
export const LEARNER_FILE_GROUPS: { label: string; exts: string[] }[] = [
  { label: "Images", exts: ["png", "jpg", "jpeg"] },
  { label: "Documents", exts: ["pdf", "doc", "docx"] },
  { label: "Spreadsheets", exts: ["csv", "xls", "xlsx"] },
  { label: "Presentations", exts: ["ppt", "pptx"] },
  { label: "Code / data", exts: ["txt", "py", "js", "sql"] },
];

export const DEFAULT_FILE_TYPES = ["pdf", "docx", "csv", "xlsx"];

export const TEXT_RESPONSE: ResponseConfig = {
  type: "text",
  allowedTypes: DEFAULT_FILE_TYPES,
  maxSizeMb: 20,
  maxFiles: 1,
  allowReplace: true,
  fileRequired: true,
};

/** Only subjective, non-group questions have a configurable learner response. */
export function hasConfigurableResponse(q: Pick<Question, "type">) {
  return !hasOptions(q.type) && !isGroupType(q.type);
}

export function responseOf(q: Question): ResponseConfig {
  return q.response ?? TEXT_RESPONSE;
}

export const acceptsText = (r: ResponseConfig) => r.type === "text" || r.type === "text_file";
export const acceptsFiles = (r: ResponseConfig) => r.type === "file" || r.type === "text_file";

export function acceptLabel(exts: string[]) {
  return exts.map((e) => e.toUpperCase()).join(", ");
}

export interface AnswerDraft {
  selected: string[];
  text: string;
  attachments: AnswerAttachment[];
}

export type AnswerState = "empty" | "partial" | "complete";

/**
 * Mock validation. Objective: an option chosen. Text: text present. File: required file(s) present.
 * Text + File: only complete when every required component is present.
 */
export function answerState(q: Question, a: AnswerDraft | undefined): AnswerState {
  if (!a) return "empty";
  if (hasOptions(q.type)) return a.selected.length ? "complete" : "empty";
  const r = responseOf(q);
  const hasText = a.text.trim().length > 0;
  const hasFile = a.attachments.length > 0;
  if (r.type === "text") return hasText ? "complete" : "empty";
  if (r.type === "file") return hasFile ? "complete" : "empty";
  const textOk = hasText;
  const fileOk = hasFile || !r.fileRequired;
  if (textOk && fileOk) return "complete";
  return hasText || hasFile ? "partial" : "empty";
}

/** True when the question needs a file that hasn't been uploaded. */
export function missingRequiredFile(q: Question, a: AnswerDraft | undefined) {
  if (hasOptions(q.type)) return false;
  const r = responseOf(q);
  return acceptsFiles(r) && r.fileRequired && !(a?.attachments.length);
}
