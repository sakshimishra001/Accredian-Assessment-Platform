import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db, type DbTx } from "./db";

export const AuditAction = {
  LOGIN_SUCCEEDED: "auth.login_succeeded",
  LOGIN_FAILED: "auth.login_failed",
  LOGOUT: "auth.logout",
  QUESTION_CREATED: "question.created",
  QUESTION_UPDATED: "question.updated",
  QUESTION_ARCHIVED: "question.archived",
  QUESTION_RESTORED: "question.restored",
  QUESTION_DELETED: "question.deleted",
  ASSESSMENT_CREATED: "assessment.created",
  ASSESSMENT_UPDATED: "assessment.updated",
  ASSESSMENT_STATUS_CHANGED: "assessment.status_changed",
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
