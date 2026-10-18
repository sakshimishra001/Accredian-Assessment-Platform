import type { AssessmentCommunication, CommTemplate, ReminderTiming } from "../types";
import { formatDate, formatDuration, formatTime, fromIstParts } from "./format";

// Variables and the renderer are the real ones (shared with the template service).
import { SAMPLE_VALUES, type VariableValues } from "@/lib/communication/templates";
export { ALL_VARIABLES, SAMPLE_VALUES, VARIABLE_GROUPS, resolveVariables, type VariableValues } from "@/lib/communication/templates";

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
