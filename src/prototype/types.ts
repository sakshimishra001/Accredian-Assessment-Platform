// Domain types for the clickable UI prototype. All data is in-memory mock state.

export type Role = "admin" | "examiner" | "reviewer" | "learner";

export interface SessionUser {
  name: string;
  email: string;
  role: Role;
}

export interface Course {
  id: string;
  name: string;
  code: string;
}

export type BatchStatus = "Active" | "Upcoming" | "Completed";

export interface Batch {
  /** Internal identifier — never shown to admins. */
  id: string;
  /** Short display name used in compact places (tables, filters), e.g. "PM-01". */
  label: string;
  /** Full batch name as entered by the admin. */
  name: string;
  courseId: string;
  createdAt: string; // ISO
  startDate?: string; // ISO — cohort start, when known
  status: BatchStatus;
  learnerIds: string[];
}

export type LearnerStatus = "Active" | "Invited" | "Inactive";

export interface Learner {
  id: string;
  name: string;
  email: string;
  batchId: string;
  status: LearnerStatus;
}

export type QuestionType =
  | "MCQ_SINGLE"
  | "MCQ_MULTI"
  | "TRUE_FALSE"
  | "SHORT_ANSWER"
  | "LONG_ANSWER"
  | "COMPREHENSION"
  | "CASE_STUDY";

export type MaterialKind = "image" | "document" | "dataset";

/** A file attached by an admin to a question for learners to consult. (Not a learner answer upload.) */
export interface SupportingMaterial {
  id: string;
  name: string;
  kind: MaterialKind;
  /** Lower-case extension without the dot, e.g. "pdf". */
  ext: string;
  sizeKb: number;
  description?: string;
}

export interface QuestionOption {
  id: string;
  text: string;
  correct: boolean;
}

export interface Question {
  id: string;
  /** Display number, e.g. "7" or "1(b)". */
  number: string;
  type: QuestionType;
  text: string;
  /** Passage for comprehension / case-study groups. */
  passage?: string;
  options: QuestionOption[];
  marks: number;
  sectionId: string;
  compulsory: boolean;
  needsReview: boolean;
  reviewNote?: string;
  children: Question[];
  /** Admin-provided resources the learner consults (never the learner's own files). */
  materials?: SupportingMaterial[];
  /** How the learner answers subjective questions. Defaults to a text answer. */
  response?: ResponseConfig;
  /** Extra guidance shown to learners, e.g. what to do with a supporting file. */
  instructions?: string;
}

export type ResponseType = "text" | "file" | "text_file";

export interface ResponseConfig {
  type: ResponseType;
  /** Lower-case extensions the learner may upload, e.g. ["csv", "xlsx"]. */
  allowedTypes: string[];
  maxSizeMb: number;
  maxFiles: number;
  allowReplace: boolean;
  /** Whether an uploaded file is required for the answer to count. */
  fileRequired: boolean;
}

/**
 * A file the LEARNER submits as (part of) their answer.
 * Belongs to Assessment → Attempt → Question → Learner answer. Separate from SupportingMaterial.
 */
export interface AnswerAttachment {
  id: string;
  name: string;
  ext: string;
  sizeKb: number;
  uploadedAt: string; // ISO
}

export interface LearnerAnswer {
  assessmentId: string;
  attemptNo: number;
  learnerId: string;
  questionId: string;
  selected: string[];
  text: string;
  attachments: AnswerAttachment[];
}

export type AttemptRuleKind = "COMPULSORY" | "OPTIONAL" | "ANY_N" | "EXACTLY_N" | "BEST_N" | "UP_TO_N";

export interface Section {
  id: string;
  name: string;
  /** e.g. "Q1–Q2" */
  range: string;
  rule: AttemptRuleKind;
  /** N for ANY/EXACTLY/BEST/UP_TO rules. */
  ruleCount?: number;
  /** Marks this section contributes to the paper total. */
  marks: number;
}

export type PaperStatus = "Draft" | "Processing" | "Needs Review" | "Approved" | "Archived";
export type ImportSource = "Excel" | "Word" | "PDF" | "Manual";

export interface QuestionPaper {
  id: string;
  name: string;
  courseId: string;
  subject: string;
  batchId: string;
  description: string;
  version: string;
  status: PaperStatus;
  source: ImportSource;
  fileName?: string;
  importedOn: string; // ISO
  durationMinutes: number;
  sections: Section[];
  questions: Question[];
}

export type AssessmentStatus = "Draft" | "Scheduled" | "Active" | "Completed" | "Evaluation" | "Published";
export type AssessmentType = "Objective" | "Subjective" | "Mixed";

export type TimingMode = "window" | "full";
export type ResultVisibility = "score" | "score_answers" | "full_feedback";

export interface AssessmentSettings {
  /** window: attempts end when the window closes; full: learners always get the full duration if they start within the window. */
  timingMode: TimingMode;
  randomizeQuestions: boolean;
  randomizeOptions: boolean;
  showResultsImmediately: boolean;
  resultVisibility: ResultVisibility;
  allowResume: boolean;
  showQuestionPalette: boolean;
  allowMarkForReview: boolean;
  proctoring: boolean;
}

export interface AssessmentSchedule {
  mode: "later" | "now";
  start: string; // ISO
  end: string; // ISO
  notifyLearners: boolean;
  sendReminder: boolean;
}

export interface Assessment {
  id: string;
  name: string;
  courseId: string;
  batchId: string;
  paperId: string | null;
  type: AssessmentType;
  description: string;
  instructions: string;
  durationMinutes: number;
  maxAttempts: number;
  negativeMarking: boolean;
  negativeMarks: number;
  settings: AssessmentSettings;
  schedule: AssessmentSchedule;
  status: AssessmentStatus;
  examinerIds: string[];
  createdAt: string;
  /** Mock progress for active/completed assessments. */
  attempted: number;
  communication?: AssessmentCommunication;
}

export type ExaminerStatus = "Active" | "Invited" | "Inactive";

export interface Examiner {
  id: string;
  name: string;
  email: string;
  specialization: string;
  status: ExaminerStatus;
}

export type UserRole = "Administrator" | "Examiner" | "Doctor / Reviewer";
export type UserStatus = "Active" | "Invited" | "Suspended";

export interface PlatformUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  lastActive: string; // ISO or ""
}

export type ResultStatus = "Passed" | "Failed" | "Pending evaluation" | "Absent";

export interface ResultRow {
  id: string;
  learnerId: string;
  assessmentId: string;
  score: number | null;
  max: number;
  status: ResultStatus;
  submittedAt: string | null;
  timeTakenMinutes: number | null;
}

export type EvaluationStatus = "Pending" | "In progress" | "Completed";

export interface EvaluationAnswer {
  questionNumber: string;
  questionText: string;
  answer: string;
  maxMarks: number;
  marks: number | null;
  comment: string;
}

export interface Evaluation {
  id: string;
  assessmentId: string;
  learnerId: string;
  examinerId: string;
  status: EvaluationStatus;
  dueDate: string;
  answers: EvaluationAnswer[];
}

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  time: string; // ISO
  read: boolean;
  href?: string;
}

// ---------------------------------------------------------------------------
// Communication
// ---------------------------------------------------------------------------

export type CommType = "Assessment" | "Reminder" | "Assessment Update" | "Results";
export type CommTemplateStatus = "Active" | "Draft" | "Disabled";

/** Reusable, organisation-wide email template ("what does our standard email look like?"). */
export interface CommTemplate {
  id: string;
  name: string;
  type: CommType;
  trigger: string;
  subject: string;
  /** Lightweight markup: **bold**, _italic_, "- " bullets, [text](url), blank line = new paragraph. */
  body: string;
  status: CommTemplateStatus;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  updatedAt: string; // ISO
}

export type ReminderTiming = "24h" | "12h" | "2h" | "custom";

/** Per-assessment communication ("which email, to whom, and when — for THIS assessment"). */
export interface CommSetting {
  enabled: boolean;
  templateId: string;
  /** Assessment-only content; the global template is never modified. */
  override?: { subject: string; body: string };
}

export interface AssessmentCommunication {
  audience: "batch" | "selected";
  selectedLearnerIds: string[];
  assignment: CommSetting;
  reminder: CommSetting & { timing: ReminderTiming; customDate: string; customTime: string };
  startingSoon: CommSetting;
  rescheduled: CommSetting;
  cancelled: CommSetting;
  resultPublished: CommSetting;
}

export type CommHistoryStatus = "Draft" | "Scheduled" | "Sent" | "Failed";

export interface CommHistoryEntry {
  id: string;
  date: string; // ISO — sent or scheduled time
  templateId: string;
  communication: string;
  assessmentId: string | null;
  assessmentName: string;
  batchName: string;
  recipients: number;
  status: CommHistoryStatus;
  subject: string;
}
