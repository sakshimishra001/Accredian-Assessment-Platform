import { FileSpreadsheet, FileText, FileType2 } from "lucide-react";

export const IMPORT_METHODS = [
  {
    key: "excel",
    icon: FileSpreadsheet,
    title: "Excel Template",
    body: "Most reliable. One row per question with sections, marks and answer keys in columns.",
    accept: ".xlsx",
  },
  {
    key: "word",
    icon: FileText,
    title: "Word Document",
    body: "Upload a formatted .docx paper. Numbering, sections and options are detected from headings and lists.",
    accept: ".docx",
  },
  {
    key: "pdf",
    icon: FileType2,
    title: "PDF Question Paper",
    body: "AI-assisted extraction from an existing PDF. Flagged questions need review before approval.",
    accept: ".pdf",
  },
] as const;

export type ImportMethodKey = (typeof IMPORT_METHODS)[number]["key"];
