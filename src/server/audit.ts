import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db, type DbTx } from "./db";

export const AuditAction = {
  LOGIN_SUCCEEDED: "auth.login_succeeded",
  LOGIN_FAILED: "auth.login_failed",
  LOGIN_THROTTLED: "auth.login_throttled",
  LOGOUT: "auth.logout",
  EXAM_LOGIN_SUCCEEDED: "auth.exam_login_succeeded",
  EXAM_LOGIN_FAILED: "auth.exam_login_failed",
  LEARNER_CREATED: "learner.created",
  USER_STATUS_CHANGED: "user.status_changed",
  STAFF_CREATED: "staff.created",
  STAFF_PASSWORD_LINK_ISSUED: "staff.password_link_issued",
  STAFF_PASSWORD_SET: "staff.password_set",
  LEARNER_PASSWORD_ISSUED: "learner.password_issued",
  COURSE_CREATED: "course.created",
  COURSE_UPDATED: "course.updated",
  BATCH_CREATED: "batch.created",
  BATCH_UPDATED: "batch.updated",
  BATCH_MEMBERS_ADDED: "batch.members_added",
  BATCH_MEMBER_REMOVED: "batch.member_removed",
  CANDIDATES_ASSIGNED: "assessment.candidates_assigned",
  CANDIDATE_REMOVED: "assessment.candidate_removed",
  EXAMINER_ASSIGNED: "assessment.examiner_assigned",
  PROCTOR_ASSIGNED: "assessment.proctor_assigned",
  PROCTOR_UNASSIGNED: "assessment.proctor_unassigned",
  EXAM_CREDENTIAL_ISSUED: "exam_credential.issued",
  EXAM_CREDENTIAL_REVOKED: "exam_credential.revoked",
  ATTEMPT_STARTED: "attempt.started",
  ATTEMPT_SUBMITTED: "attempt.submitted",
  ATTEMPT_AUTO_SUBMITTED: "attempt.auto_submitted",
  ATTEMPT_TERMINATED: "attempt.terminated",
  ATTEMPTS_BULK_TERMINATED: "attempt.bulk_terminated",
  ATTEMPT_TIME_EXTENDED: "attempt.time_extended",
  ATTEMPT_FOCUS_VIOLATION: "attempt.focus_violation",
  ATTEMPT_LOCKED: "attempt.locked",
  PROCTORING_VIOLATION: "attempt.proctoring_violation",
  ATTEMPTS_BULK_TIME_EXTENDED: "attempt.bulk_time_extended",
  EVALUATION_SAVED: "evaluation.saved",
  EVALUATION_FINALIZED: "evaluation.finalized",
  EVALUATION_REOPENED: "evaluation.reopened",
  MATERIAL_ADDED: "file.material_added",
  MATERIAL_REMOVED: "file.material_removed",
  ANSWER_FILE_UPLOADED: "file.answer_uploaded",
  ANSWER_FILE_REMOVED: "file.answer_removed",
  FILE_DELETED: "file.deleted",
  FILE_REJECTED: "file.rejected_malware",
  FILE_ACCESSED: "file.accessed",
  RESULT_VIEWED: "result.viewed",
  REPORT_DOWNLOADED: "report.downloaded",
  TEMPLATE_CREATED: "communication.template_created",
  TEMPLATE_UPDATED: "communication.template_updated",
  COMMUNICATION_SETTINGS_UPDATED: "communication.settings_updated",
  COMMUNICATION_DISPATCHED: "communication.dispatched",
  QUESTION_CREATED: "question.created",
  QUESTION_UPDATED: "question.updated",
  QUESTION_ARCHIVED: "question.archived",
  QUESTION_RESTORED: "question.restored",
  QUESTION_DELETED: "question.deleted",
  PAPER_CREATED: "question_paper.created",
  PAPER_UPDATED: "question_paper.updated",
  PAPER_STRUCTURE_CHANGED: "question_paper.structure_changed",
  PAPER_IMPORTED: "question_paper.imported",
  PAPER_STATUS_CHANGED: "question_paper.status_changed",
  PAPER_REVISION_CREATED: "question_paper.revision_created",
  ASSESSMENT_CREATED: "assessment.created",
  ASSESSMENT_UPDATED: "assessment.updated",
  ASSESSMENT_STATUS_CHANGED: "assessment.status_changed",
  ASSESSMENT_PUBLISHED: "assessment.published",
  ASSESSMENT_PAUSED: "assessment.paused",
  ASSESSMENT_RESUMED: "assessment.resumed",
  RESULTS_PUBLISHED: "results.published",
  ASSESSMENT_QUESTIONS_ADDED: "assessment.questions_added",
  ASSESSMENT_QUESTION_REMOVED: "assessment.question_removed",
  ASSESSMENT_QUESTION_UPDATED: "assessment.question_updated",
  ASSESSMENT_QUESTIONS_REORDERED: "assessment.questions_reordered",
  ASSESSMENT_QUESTION_REFRESHED: "assessment.question_refreshed",
} as const;

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  actorId?: string | null;
  action: AuditActionName;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

/**
 * Append an audit record. Pass `tx` to write it in the same transaction as the change it describes.
 */
export async function recordAudit(entry: AuditEntry, tx: DbTx = db) {
  await tx.auditLog.create({
    data: {
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: entry.metadata,
      ipAddress: entry.ipAddress ?? null,
    },
  });
}
