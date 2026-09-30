import type { AssessmentCommunication, CommTemplate, ReminderTiming } from "../types";
import { formatDate, formatDuration, formatTime, fromIstParts } from "./format";

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
  support_email: "support@example.com",
  company_name: "Accredian",
};

export function resolveVariables(text: string, values: VariableValues) {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key: string) => values[key] ?? m);
}

export function valuesForAssessment(input: {
  name: string;
  courseName?: string;
  batchName?: string;
  start: string;
  end: string;
  durationMinutes: number;
  learnerName?: string;
  learnerEmail?: string;
  supportEmail: string;
  companyName: string;
}): VariableValues {
  return {
    ...SAMPLE_VALUES,
    learner_name: input.learnerName?.split(" ")[0] ?? SAMPLE_VALUES.learner_name,
    learner_email: input.learnerEmail ?? SAMPLE_VALUES.learner_email,
    assessment_name: input.name || "Untitled assessment",
    course_name: input.courseName ?? "—",
    batch_name: input.batchName ?? "—",
    assessment_start_date: formatDate(input.start),
    assessment_start_time: formatTime(input.start),
    assessment_end_date: formatDate(input.end),
    assessment_end_time: formatTime(input.end),
    assessment_duration: `${input.durationMinutes} minutes (${formatDuration(input.durationMinutes)})`,
    support_email: input.supportEmail,
    company_name: input.companyName.split(" ")[0] || input.companyName,
  };
}

export function defaultCommunication(templates: CommTemplate[]): AssessmentCommunication {
  const id = (name: string) => templates.find((t) => t.name === name)?.id ?? "";
  return {
    audience: "batch",
    selectedLearnerIds: [],
    assignment: { enabled: true, templateId: id("Exam Assignment") },
    reminder: { enabled: false, templateId: id("Exam Reminder"), timing: "24h", customDate: "", customTime: "09:00" },
    startingSoon: { enabled: false, templateId: id("Exam Starting Soon") },
    rescheduled: { enabled: false, templateId: id("Exam Rescheduled") },
    cancelled: { enabled: false, templateId: id("Exam Cancelled") },
    resultPublished: { enabled: true, templateId: id("Result Published") },
  };
}

export const REMINDER_LABEL: Record<ReminderTiming, string> = {
  "24h": "24 hours before",
  "12h": "12 hours before",
  "2h": "2 hours before",
  custom: "Custom",
};

const HOURS: Record<Exclude<ReminderTiming, "custom">, number> = { "24h": 24, "12h": 12, "2h": 2 };

/** When the reminder would go out (ISO), or null if the custom date/time is incomplete. */
export function reminderAt(r: AssessmentCommunication["reminder"], startIso: string): string | null {
  if (r.timing === "custom") return fromIstParts(r.customDate, r.customTime);
  return new Date(new Date(startIso).getTime() - HOURS[r.timing] * 3600000).toISOString();
}

export function reminderTimingText(r: AssessmentCommunication["reminder"], startIso: string) {
  if (r.timing !== "custom") return `${REMINDER_LABEL[r.timing]} the assessment`;
  const t = reminderAt(r, startIso);
  return t ? `Scheduled · ${formatDate(t)}, ${formatTime(t)} IST` : "Custom time not set";
}

/**
 * Edge-case validation for the reminder. The assignment email goes out when the assessment is
 * published (≈ now), so a reminder must fall after that and before the assessment starts.
 */
export function reminderProblem(r: AssessmentCommunication["reminder"], startIso: string, assignmentAt: number): string | null {
  if (!r.enabled) return null;
  const t = reminderAt(r, startIso);
  if (!t) return "Choose a date and time for the custom reminder.";
  const ms = new Date(t).getTime();
  if (ms <= assignmentAt) return "Reminder must be scheduled after the assignment communication.";
  if (ms >= new Date(startIso).getTime()) return "Reminder must be sent before the assessment starts.";
  return null;
}
