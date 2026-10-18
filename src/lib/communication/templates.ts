/*
 * Email templates: the variable allowlist and the one renderer, shared by the template editor's
 * preview and by sending. Variables are plain {{name}} placeholders replaced with text — there is
 * no template language, so nothing in a template can execute. Unknown names are rejected on save.
 */

export const VARIABLE_GROUPS: { label: string; vars: string[] }[] = [
  { label: "Learner", vars: ["learner_name", "learner_email"] },
  {
    label: "Assessment",
    vars: [
      "assessment_name",
      "course_name",
      "assessment_start_date",
      "assessment_start_time",
      "assessment_end_date",
      "assessment_end_time",
      "assessment_duration",
      "assessment_link",
    ],
  },
  { label: "Batch", vars: ["batch_name"] },
  // Filled in only for Result Published emails, from that learner's own result.
  { label: "Result (Result Published only)", vars: ["marks_obtained", "total_marks", "percentage", "result_status", "result_url"] },
  { label: "System", vars: ["support_email", "company_name"] },
];

export const ALL_VARIABLES = VARIABLE_GROUPS.flatMap((g) => g.vars);

export type VariableValues = Record<string, string>;

/** Realistic sample values for previewing a template outside any assessment. */
export const SAMPLE_VALUES: VariableValues = {
  learner_name: "Sakshi",
  learner_email: "sakshi@example.com",
  assessment_name: "Data Science Final Assessment",
  course_name: "Data Science",
  batch_name: "Data Science — July 2026 — Batch 01",
  assessment_start_date: "15 October 2026",
  assessment_start_time: "10:00 AM",
  assessment_end_date: "15 October 2026",
  assessment_end_time: "12:00 PM",
  assessment_duration: "120 minutes",
  assessment_link: "https://assessments.example.com/a/ds-final",
  marks_obtained: "42",
  total_marks: "50",
  percentage: "84",
  result_status: "Pass",
  result_url: "https://assessments.example.com/login?next=%2Flearner%2Fresults%2Fexample",
  support_email: "support@example.com",
  company_name: "Accredian",
};

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Replace {{variables}} with plain-text values. Unknown names are left as written. */
export function resolveVariables(text: string, values: VariableValues) {
  return text.replace(PLACEHOLDER, (m, key: string) => values[key] ?? m);
}

/** Placeholder names that aren't in the allowlist (for validation). */
export function unknownVariables(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]).filter((v) => !ALL_VARIABLES.includes(v)))];
}

export interface RenderedEmail {
  subject: string;
  /** The body after variable substitution, in the lightweight markup. */
  body: string;
  /** Plain-text version for email clients. */
  text: string;
  /** HTML version: every piece of text is escaped; only the known markup becomes tags. */
  html: string;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const safeUrl = (url: string) => (/^(https?:\/\/|mailto:)/i.test(url.trim()) ? url.trim() : "#");

function inlineHtml(line: string) {
  return line
    .split(/(\*\*[^*]+\*\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g)
    .map((tok) => {
      if (/^\*\*[^*]+\*\*$/.test(tok)) return `<strong>${escapeHtml(tok.slice(2, -2))}</strong>`;
      if (/^_[^_]+_$/.test(tok)) return `<em>${escapeHtml(tok.slice(1, -1))}</em>`;
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (link) return `<a href="${escapeHtml(safeUrl(link[2]))}">${escapeHtml(link[1])}</a>`;
      return escapeHtml(tok);
    })
    .join("");
}

/** Markup → HTML (paragraphs, "- " bullet lists, **bold**, _italic_, [text](url)), escaping everything else. */
export function markupToHtml(markup: string) {
  return markup
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((l) => l.trim().startsWith("- "))) return `<ul>${lines.map((l) => `<li>${inlineHtml(l.trim().slice(2))}</li>`).join("")}</ul>`;
      return `<p>${lines.map(inlineHtml).join("<br>")}</p>`;
    })
    .join("\n");
}

/** Markup → plain text. */
export function markupToText(markup: string) {
  return markup.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/_([^_]+)_/g, "$1").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

/** The one renderer: substitute variables, then produce text and escaped HTML. */
export function renderTemplate(content: { subject: string; body: string }, values: VariableValues): RenderedEmail {
  const subject = resolveVariables(content.subject, values).replace(/[\r\n]+/g, " ");
  const body = resolveVariables(content.body, values);
  return { subject, body, text: markupToText(body), html: markupToHtml(body) };
}

// ---------------------------------------------------------------------------
// Assessment communications
// ---------------------------------------------------------------------------

export type CommunicationEventKey = "ASSIGNMENT" | "REMINDER" | "STARTING_SOON" | "RESCHEDULED" | "CANCELLED" | "RESULT_PUBLISHED";

export const COMMUNICATION_EVENTS: { key: CommunicationEventKey; label: string; timing: string; defaultTemplate: string; defaultEnabled: boolean; scheduled: boolean }[] = [
  { key: "ASSIGNMENT", label: "Assignment email", timing: "When the assessment is published", defaultTemplate: "Exam Assignment", defaultEnabled: true, scheduled: false },
  { key: "REMINDER", label: "Reminder", timing: "Before the assessment (set below)", defaultTemplate: "Exam Reminder", defaultEnabled: false, scheduled: true },
  { key: "STARTING_SOON", label: "Exam Starting Soon", timing: "1 hour before the assessment", defaultTemplate: "Exam Starting Soon", defaultEnabled: false, scheduled: true },
  { key: "RESCHEDULED", label: "Exam Rescheduled", timing: "When the schedule changes after publishing", defaultTemplate: "Exam Rescheduled", defaultEnabled: false, scheduled: false },
  { key: "CANCELLED", label: "Exam Cancelled", timing: "When a scheduled assessment is moved back to draft", defaultTemplate: "Exam Cancelled", defaultEnabled: false, scheduled: false },
  { key: "RESULT_PUBLISHED", label: "Result Published", timing: "When results are published", defaultTemplate: "Result Published", defaultEnabled: true, scheduled: false },
];

export type ReminderTimingKey = "H24" | "H12" | "H2" | "CUSTOM";
export const REMINDER_LABEL: Record<ReminderTimingKey, string> = { H24: "24 hours before", H12: "12 hours before", H2: "2 hours before", CUSTOM: "Custom date & time" };
export const REMINDER_HOURS: Record<Exclude<ReminderTimingKey, "CUSTOM">, number> = { H24: 24, H12: 12, H2: 2 };

export const COMMUNICATION_TYPE_LABEL = { ASSESSMENT: "Assessment", REMINDER: "Reminder", ASSESSMENT_UPDATE: "Assessment Update", RESULTS: "Results" } as const;
export const TEMPLATE_STATUS_LABEL = { ACTIVE: "Active", DRAFT: "Draft", DISABLED: "Disabled" } as const;
export const DELIVERY_STATUS_LABEL = { PENDING: "Queued", SENDING: "Sending", SENT: "Sent", FAILED: "Failed", NOT_DELIVERED: "Not delivered (no email service)" } as const;
