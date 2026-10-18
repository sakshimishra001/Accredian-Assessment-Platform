import { toIstInput } from "@/lib/datetime";

/*
 * View models for the Courses / Batches screens. The database stays authoritative: statuses here
 * are derived from real fields, never stored separately.
 */

export type BatchStatusLabel = "Active" | "Upcoming" | "Completed" | "Inactive";
export type LearnerStatusLabel = "Active" | "Inactive";

/** Inactive when switched off; otherwise from the optional cohort dates (Upcoming / Completed / Active). */
export function batchStatus(b: { isActive: boolean; startDate: Date | null; endDate: Date | null }, now: Date = new Date()): BatchStatusLabel {
  if (!b.isActive) return "Inactive";
  if (b.startDate && b.startDate > now) return "Upcoming";
  if (b.endDate && b.endDate < now) return "Completed";
  return "Active";
}

export const learnerStatus = (status: "ACTIVE" | "DISABLED"): LearnerStatusLabel => (status === "ACTIVE" ? "Active" : "Inactive");

/** "2026-09-01" (IST) for a date input, or "". */
export const toDateInput = (d: Date | null) => (d ? toIstInput(d).slice(0, 10) : "");

export interface CourseOption {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface CourseRow extends CourseOption {
  description: string | null;
  batchCount: number;
  createdAt: string;
}

export interface BatchRow {
  id: string;
  name: string;
  code: string | null;
  course: CourseOption;
  status: BatchStatusLabel;
  isActive: boolean;
  learnerCount: number;
  createdAt: string;
  startDate: string;
  endDate: string;
}

export interface BatchLearnerRow {
  id: string;
  name: string;
  email: string;
  status: LearnerStatusLabel;
  addedAt: string;
}

type BatchLike = {
  id: string;
  name: string;
  code: string | null;
  isActive: boolean;
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date;
  course: CourseOption;
};

export function toBatchRow(b: BatchLike & { learnerCount: number }): BatchRow {
  return {
    id: b.id,
    name: b.name,
    code: b.code,
    course: b.course,
    status: batchStatus(b),
    isActive: b.isActive,
    learnerCount: b.learnerCount,
    createdAt: b.createdAt.toISOString(),
    startDate: toDateInput(b.startDate),
    endDate: toDateInput(b.endDate),
  };
}
