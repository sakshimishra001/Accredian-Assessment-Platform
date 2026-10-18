import "server-only";
import { createHash } from "node:crypto";
import { ValidationError } from "@/lib/errors";
import { extensionOf, FILE_TYPES, formatBytes, RETIRED_UPLOAD_EXTENSIONS } from "@/lib/files/types";

export interface ValidatedFile {
  fileName: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  data: Buffer;
}

const startsWith = (data: Buffer, bytes: number[]) => bytes.every((b, i) => data[i] === b);
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/** Plain text: no NUL bytes and valid UTF-8 (BOM allowed). */
function isText(data: Buffer) {
  if (data.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Office Open XML parts that carry executable content: VBA macros (also present when a .docm/.xlsm
 * is renamed to .docx/.xlsx) and ActiveX controls. Part names are stored uncompressed in the ZIP
 * headers, so they can be found without unpacking.
 */
const ACTIVE_CONTENT = ["vbaProject.bin", "vbaData.xml", "activeX/"];

function hasActiveContent(data: Buffer) {
  return ACTIVE_CONTENT.some((part) => data.includes(part));
}

/** Does the content match the extension? The browser's MIME type is never trusted. */
function contentMatches(ext: string, data: Buffer): boolean {
  switch (ext) {
    case "png":
      return startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "jpg":
    case "jpeg":
      return startsWith(data, [0xff, 0xd8, 0xff]);
    case "pdf":
      return data.subarray(0, 5).toString("latin1") === "%PDF-";
    case "docx":
      return startsWith(data, ZIP) && data.includes("word/");
    case "xlsx":
      return startsWith(data, ZIP) && data.includes("xl/");
    case "pptx":
      return startsWith(data, ZIP) && data.includes("ppt/");
    case "csv":
    case "txt":
    case "py":
    case "js":
    case "sql":
      return isText(data);
    default:
      return false;
  }
}

/** A safe display name: no path, no control characters, at most 200 characters. */
export function sanitizeFileName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").trim();
  return clean.slice(-200) || "file";
}

/**
 * Validate an uploaded file against the allowed extensions and size limit, checking the content
 * (magic bytes / text) rather than the browser's claim. Returns what the server will store.
 */
export function validateUpload(file: { name: string; data: Buffer }, rules: { allowed: readonly string[]; maxBytes: number }, field = "file"): ValidatedFile {
  const fileName = sanitizeFileName(file.name);
  const extension = extensionOf(fileName);
  const fail = (message: string): never => {
    throw new ValidationError(message, { [field]: [message] });
  };
  if (RETIRED_UPLOAD_EXTENSIONS.includes(extension)) {
    fail(`.${extension} files are no longer accepted. Save it as ${extension === "svg" ? "PNG, JPEG or PDF" : `.${extension}x or PDF`} instead.`);
  }
  if (!extension || !FILE_TYPES[extension] || !rules.allowed.includes(extension)) {
    fail(`This file type isn’t accepted here. Allowed: ${rules.allowed.map((e) => `.${e}`).join(", ")}.`);
  }
  if (file.data.length === 0) fail("The file is empty.");
  if (file.data.length > rules.maxBytes) fail(`The file is too large (${formatBytes(file.data.length)}). The limit is ${formatBytes(rules.maxBytes)}.`);
  if (!contentMatches(extension, file.data)) fail(`The file’s content doesn’t match a .${extension} file.`);
  if (["docx", "xlsx", "pptx"].includes(extension) && hasActiveContent(file.data)) {
    fail("Files with macros or ActiveX controls aren’t accepted. Save a copy without macros and upload that.");
  }
  return {
    fileName,
    extension,
    mimeType: FILE_TYPES[extension].mime,
    sizeBytes: file.data.length,
    sha256: createHash("sha256").update(file.data).digest("hex"),
    data: file.data,
  };
}
