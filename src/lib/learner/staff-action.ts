import type { Role } from "@/generated/prisma/enums";

/*
 * Who locked or terminated a learner's attempt, as the learner is told — never IDs, names, internal
 * role names or the staff's reason. Decided on the server from the attempt's own records:
 *
 * - Lock: the proctoring violation limit locks an attempt by recording a proctoring event with the
 *   action LOCK; a manual lock (proctor or administrator) has no such event and is in the audit log
 *   with the staff member who did it.
 * - Termination: the violation limit terminates with no person (terminatedById empty, the proctoring
 *   reason); a manual termination records the staff member (terminatedById), whose role says which.
 */

export type LockedBy = "violation_limit" | "proctor" | "administrator" | "staff";
export type TerminatedBy = "violation_limit" | "proctor" | "administrator" | "staff";

/** A staff member's role, as the learner may see it. */
function staffKind(role: Role | null | undefined): "proctor" | "administrator" | "staff" {
  return role === "REVIEWER" ? "proctor" : role === "ADMIN" ? "administrator" : "staff";
}

/** Who locked: the violation limit (a LOCK proctoring event exists) or the staff member in the audit log. */
export function lockedByFrom(facts: { violationLock: boolean; staffRole: Role | null | undefined }): LockedBy {
  return facts.violationLock ? "violation_limit" : staffKind(facts.staffRole);
}

/** Who terminated: no person and the proctoring reason → the violation limit; otherwise the staff member's role. */
export function terminatedByFrom(facts: { terminatedById: string | null; staffRole: Role | null | undefined; proctoringReason: boolean }): TerminatedBy {
  if (!facts.terminatedById) return facts.proctoringReason ? "violation_limit" : "staff";
  return staffKind(facts.staffRole);
}

/** The learner's lock screen. */
export const LOCK_MESSAGE: Record<LockedBy, string> = {
  violation_limit: "Your exam has been locked because the proctoring violation limit was reached.",
  proctor: "Your assessment has been locked by a proctor.",
  administrator: "Your assessment has been locked by an administrator.",
  staff: "Your assessment has been locked.",
};

/** The learner's termination screen and assessment page. */
export const TERMINATION_MESSAGE: Record<TerminatedBy, string> = {
  violation_limit: "Your assessment has been terminated because the proctoring violation limit was reached.",
  proctor: "Your assessment was terminated by a proctor.",
  administrator: "Your assessment was terminated by an administrator.",
  staff: "Your assessment has been terminated.",
};

/** One line for the learner's dashboard card. */
export const TERMINATION_LABEL: Record<TerminatedBy, string> = {
  violation_limit: "Terminated (proctoring violation limit reached)",
  proctor: "Terminated by a proctor",
  administrator: "Terminated by an administrator",
  staff: "Terminated",
};
