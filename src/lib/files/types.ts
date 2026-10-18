/*
 * File types the platform accepts, shared by the server (validation) and the UI (pickers, previews).
 * The categories are the ones the product already uses: supporting materials (images, PDF, Word,
 * Excel/CSV, PowerPoint) and learner answer uploads (the groups an admin picks from per question).
 */

export type PreviewKind = "image" | "pdf" | "csv" | "text" | null;
export type FileFamily = "image" | "document" | "spreadsheet" | "presentation" | "code";

export interface FileTypeInfo {
  /** The MIME type the server stores and serves (never the browser-supplied one). */
  mime: string;
  family: FileFamily;
  /** How the file is previewed in the app; null = download only. */
  preview: PreviewKind;
}

export const FILE_TYPES: Record<string, FileTypeInfo> = {
  png: { mime: "image/png", family: "image", preview: "image" },
  jpg: { mime: "image/jpeg", family: "image", preview: "image" },
  jpeg: { mime: "image/jpeg", family: "image", preview: "image" },
  svg: { mime: "image/svg+xml", family: "image", preview: "image" },
  pdf: { mime: "application/pdf", family: "document", preview: "pdf" },
  doc: { mime: "application/msword", family: "document", preview: null },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", family: "document", preview: null },
  xls: { mime: "application/vnd.ms-excel", family: "spreadsheet", preview: null },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", family: "spreadsheet", preview: null },
  csv: { mime: "text/csv", family: "spreadsheet", preview: "csv" },
  ppt: { mime: "application/vnd.ms-powerpoint", family: "presentation", preview: null },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", family: "presentation", preview: null },
  txt: { mime: "text/plain", family: "code", preview: "text" },
  py: { mime: "text/plain", family: "code", preview: "text" },
  js: { mime: "text/plain", family: "code", preview: "text" },
  sql: { mime: "text/plain", family: "code", preview: "text" },
};

/**
 * Formats no longer accepted for new uploads (files already stored are still served, as downloads):
 * SVG can carry script and markup that a filter can't reliably clean; the legacy binary Office
 * formats (.doc/.xls/.ppt) can carry macros and can't be checked beyond their container. Their
 * modern equivalents (.docx/.xlsx/.pptx), PDF and PNG/JPEG cover the same needs.
 */
export const RETIRED_UPLOAD_EXTENSIONS: readonly string[] = ["svg", "doc", "xls", "ppt"];

/** Supporting materials an admin can attach to a question. */
export const MATERIAL_KINDS = {
  image: { label: "Image", exts: ["png", "jpg", "jpeg"] },
  document: { label: "Document", exts: ["pdf", "docx", "pptx"] },
  dataset: { label: "Dataset/File", exts: ["xlsx", "csv"] },
} as const;
export const MATERIAL_EXTENSIONS: readonly string[] = Object.values(MATERIAL_KINDS).flatMap((k) => k.exts);
export const MAX_MATERIAL_MB = 25;

/** File types a question can accept from learners, grouped for the admin picker. */
export const LEARNER_FILE_GROUPS: { label: string; exts: string[] }[] = [
  { label: "Images", exts: ["png", "jpg", "jpeg"] },
  { label: "Documents", exts: ["pdf", "docx"] },
  { label: "Spreadsheets", exts: ["csv", "xlsx"] },
  { label: "Presentations", exts: ["pptx"] },
  { label: "Code / data", exts: ["txt", "py", "js", "sql"] },
];
export const LEARNER_EXTENSIONS: readonly string[] = LEARNER_FILE_GROUPS.flatMap((g) => g.exts);
export const DEFAULT_ANSWER_TYPES = ["pdf", "docx", "csv", "xlsx"];
export const MAX_ANSWER_MB = 50;
export const MAX_ANSWER_FILES = 5;

export const RESPONSE_TYPE_LABEL = { TEXT: "Text Answer", FILE: "File Upload", TEXT_FILE: "Text + File Upload" } as const;

/** Lower-case extension of a file name ("" when there is none). */
export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

/** The download/preview URL of a stored file (authorisation happens in the route). */
export const fileUrl = (fileId: string, opts: { inline?: boolean } = {}) => `/api/files/${fileId}${opts.inline ? "?inline=1" : ""}`;
