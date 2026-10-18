import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { AssessmentStatus, CommunicationEvent, ReminderTiming, TemplateStatus, UserStatus } from "@/generated/prisma/enums";
import { COMMUNICATION_EVENTS, renderTemplate, type CommunicationEventKey, type VariableValues } from "@/lib/communication/templates";
import { parseIstInput } from "@/lib/datetime";
import { ConflictError, NotFoundError, ValidationError, type FieldErrors } from "@/lib/errors";
import { assessmentCommunicationSchema, templateSchema, templateUpdateSchema } from "@/lib/validation/communication";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db } from "../db";
import { enqueueEmails, scheduleOutboxDelivery, type OutboxEmail } from "../email/outbox";
import { env } from "../env";
import { visibleResultsForEmail } from "./results";

/*
 * Communication: organisation-wide templates, each assessment's communication settings, queuing
 * emails in the outbox (delivered afterwards by the outbox worker — see email/outbox.ts), and the
 * history of every email produced. Rendering is the shared renderTemplate (allowlisted
 * {{variables}}, escaped HTML). Emails tied to a moment in time (reminders, "starting soon") are
 * configured but need a scheduler.
 */

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function uniqueName(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new ValidationError("A template with this name already exists.", { name: ["Name already in use"] });
  throw err;
}

const templateSelect = {
  id: true,
  name: true,
  type: true,
  trigger: true,
  subject: true,
  body: true,
  status: true,
  fromName: true,
  fromEmail: true,
  replyTo: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CommunicationTemplateSelect;

/** All templates, with how many assessments currently use each (enabled settings). */
export async function listTemplates(actor: SessionUser) {
  assertAdmin(actor);
  const rows = await db.communicationTemplate.findMany({
    orderBy: [{ type: "asc" }, { name: "asc" }],
    select: { ...templateSelect, _count: { select: { settings: { where: { enabled: true } } } } },
  });
  return rows.map(({ _count, ...t }) => ({ ...t, usedBy: _count.settings }));
}

export async function getTemplate(actor: SessionUser, id: string) {
  assertAdmin(actor);
  const t = await db.communicationTemplate.findUnique({ where: { id }, select: templateSelect });
  if (!t) throw new NotFoundError("Template not found.");
  return t;
}

export async function createTemplate(actor: SessionUser, raw: unknown) {
  assertAdmin(actor);
  const parsed = templateSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return db
    .$transaction(async (tx) => {
      const t = await tx.communicationTemplate.create({ data: { ...parsed.data, createdById: actor.id }, select: templateSelect });
      await recordAudit({ actorId: actor.id, action: AuditAction.TEMPLATE_CREATED, entityType: "CommunicationTemplate", entityId: t.id, metadata: { name: t.name } }, tx);
      return t;
    })
    .catch(uniqueName);
}

/** Update a template (any subset of fields). A template in use can't be disabled or set back to draft. */
export async function updateTemplate(actor: SessionUser, id: string, raw: unknown) {
  assertAdmin(actor);
  const parsed = templateUpdateSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return db
    .$transaction(async (tx) => {
      const current = await tx.communicationTemplate.findUnique({ where: { id }, select: { status: true } });
      if (!current) throw new NotFoundError("Template not found.");
      if (parsed.data.status && parsed.data.status !== TemplateStatus.ACTIVE && current.status === TemplateStatus.ACTIVE) {
        const inUse = await tx.assessmentCommunicationSetting.count({ where: { templateId: id, enabled: true, assessment: { status: { notIn: [AssessmentStatus.PUBLISHED, AssessmentStatus.ARCHIVED] } } } });
        if (inUse) throw new ConflictError(`This template is switched on in ${inUse} assessment${inUse === 1 ? "" : "s"}. Choose another template there first.`);
      }
      const t = await tx.communicationTemplate.update({ where: { id }, data: { ...parsed.data, updatedById: actor.id }, select: templateSelect });
      await recordAudit({ actorId: actor.id, action: AuditAction.TEMPLATE_UPDATED, entityType: "CommunicationTemplate", entityId: id, metadata: { fields: Object.keys(parsed.data) } }, tx);
      return t;
    })
    .catch(uniqueName);
}

/** Copy a template as a new draft ("Name (Copy)", "Name (Copy 2)", …). */
export async function duplicateTemplate(actor: SessionUser, id: string) {
  const source = await getTemplate(actor, id);
  const taken = new Set((await db.communicationTemplate.findMany({ where: { name: { startsWith: `${source.name} (Copy` } }, select: { name: true } })).map((t) => t.name));
  let name = `${source.name} (Copy)`;
  for (let n = 2; taken.has(name); n++) name = `${source.name} (Copy ${n})`;
  const { type, trigger, subject, body, fromName, fromEmail, replyTo } = source;
  return createTemplate(actor, { type, trigger, subject, body, fromName, fromEmail, replyTo, name: name.slice(0, 120), status: TemplateStatus.DRAFT });
}

// ---------------------------------------------------------------------------
// Assessment communication settings
// ---------------------------------------------------------------------------

type EventSetting = {
  event: CommunicationEventKey;
  enabled: boolean;
  templateId: string | null;
  overrideSubject: string | null;
  overrideBody: string | null;
  reminderTiming: ReminderTiming | null;
  reminderAt: Date | null;
  /** True when nothing was saved yet and the product defaults are shown. */
  isDefault: boolean;
};

/** Saved settings, or the defaults (assignment + result emails on, with the standard templates if active). */
async function settingsOf(assessmentId: string): Promise<EventSetting[]> {
  const [rows, templates] = await Promise.all([
    db.assessmentCommunicationSetting.findMany({ where: { assessmentId } }),
    db.communicationTemplate.findMany({ where: { status: TemplateStatus.ACTIVE }, select: { id: true, name: true } }),
  ]);
  return COMMUNICATION_EVENTS.map((e) => {
    const row = rows.find((r) => r.event === e.key);
    if (row) {
      return { event: e.key, enabled: row.enabled, templateId: row.templateId, overrideSubject: row.overrideSubject, overrideBody: row.overrideBody, reminderTiming: row.reminderTiming, reminderAt: row.reminderAt, isDefault: false };
    }
    const template = templates.find((t) => t.name === e.defaultTemplate) ?? null;
    return {
      event: e.key,
      enabled: e.defaultEnabled && !!template,
      templateId: template?.id ?? null,
      overrideSubject: null,
      overrideBody: null,
      reminderTiming: e.key === "REMINDER" ? ReminderTiming.H24 : null,
      reminderAt: null,
      isDefault: true,
    };
  });
}

/** The Communication step: each communication's setting plus the templates that can be chosen. */
export async function getAssessmentCommunication(actor: SessionUser, assessmentId: string) {
  assertAdmin(actor);
  const assessment = await db.assessment.findUnique({ where: { id: assessmentId }, select: { id: true, status: true, startAt: true } });
  if (!assessment) throw new NotFoundError("Assessment not found.");
  const settings = await settingsOf(assessmentId);
  const templates = await db.communicationTemplate.findMany({
    where: { OR: [{ status: TemplateStatus.ACTIVE }, { id: { in: settings.map((s) => s.templateId).filter((x): x is string => !!x) } }] },
    orderBy: { name: "asc" },
    select: { id: true, name: true, type: true, status: true, subject: true, body: true, fromName: true, fromEmail: true },
  });
  return { assessment, settings, templates };
}

/** Save the Communication step. Enabled communications need an active template; a custom reminder needs a valid time. */
export async function saveAssessmentCommunication(actor: SessionUser, assessmentId: string, raw: unknown, now: Date = new Date()) {
  assertAdmin(actor);
  const parsed = assessmentCommunicationSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, "Please correct the highlighted fields.");
  const input = parsed.data;

  return db.$transaction(async (tx) => {
    const assessment = await tx.assessment.findUnique({ where: { id: assessmentId }, select: { status: true, startAt: true } });
    if (!assessment) throw new NotFoundError("Assessment not found.");
    if (assessment.status === AssessmentStatus.ARCHIVED) throw new ConflictError("Archived assessments can’t be changed.");

    const ids = Object.values(input).map((s) => s.templateId).filter((x): x is string => !!x);
    const templates = new Map((await tx.communicationTemplate.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })).map((t) => [t.id, t]));
    const errors: FieldErrors = {};
    const add = (path: string, message: string) => (errors[path] ??= []).push(message);
    for (const e of COMMUNICATION_EVENTS) {
      const s = input[e.key];
      if (s.templateId && !templates.has(s.templateId)) add(`${e.key}.templateId`, "Template not found");
      else if (s.enabled && !s.templateId) add(`${e.key}.templateId`, "Choose a template");
      else if (s.enabled && templates.get(s.templateId!)?.status !== TemplateStatus.ACTIVE) add(`${e.key}.templateId`, "Only active templates can be used");
    }
    let reminderAt: Date | null = null;
    if (input.REMINDER.reminderTiming === "CUSTOM") {
      reminderAt = input.REMINDER.reminderAt ? parseIstInput(input.REMINDER.reminderAt) : null;
      if (!reminderAt) add("REMINDER.reminderAt", "Choose the reminder date and time");
      else if (input.REMINDER.enabled && reminderAt.getTime() <= now.getTime()) add("REMINDER.reminderAt", "The reminder must be in the future");
      else if (input.REMINDER.enabled && reminderAt.getTime() >= assessment.startAt.getTime()) add("REMINDER.reminderAt", "The reminder must be before the assessment starts");
    }
    if (Object.keys(errors).length) throw new ValidationError("Please correct the highlighted fields.", errors);

    for (const e of COMMUNICATION_EVENTS) {
      const s = input[e.key];
      const data = {
        enabled: s.enabled,
        templateId: s.templateId,
        overrideSubject: s.overrideSubject,
        overrideBody: s.overrideBody,
        reminderTiming: e.key === "REMINDER" ? input.REMINDER.reminderTiming : null,
        reminderAt: e.key === "REMINDER" ? reminderAt : null,
      };
      await tx.assessmentCommunicationSetting.upsert({ where: { assessmentId_event: { assessmentId, event: e.key } }, create: { assessmentId, event: e.key, ...data }, update: data });
    }
    await recordAudit(
      { actorId: actor.id, action: AuditAction.COMMUNICATION_SETTINGS_UPDATED, entityType: "Assessment", entityId: assessmentId, metadata: { enabled: COMMUNICATION_EVENTS.filter((e) => input[e.key].enabled).map((e) => e.key) } },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Sending (event-triggered) and history
// ---------------------------------------------------------------------------

const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Queue one communication of an assessment for its learners: one rendered email per recipient is
 * recorded in the outbox (PENDING) — nothing is sent during the request. Does nothing if the
 * communication is off or its template isn't active.
 *
 * Result Published is personal: one email per learner whose result is now visible to them, with
 * only that learner's own marks (from the result calculation) and a link to their result page. Each
 * is keyed RESULT_PUBLISHED:<attemptId>, so the same result never produces a second automatic email.
 * A learner without a usable address gets a FAILED history entry instead of stopping the others.
 */
export async function dispatchAssessmentEvent(assessmentId: string, event: CommunicationEventKey, actorId: string | null) {
  const setting = (await settingsOf(assessmentId)).find((s) => s.event === event)!;
  if (!setting.enabled || !setting.templateId) return { queued: 0, skipped: "Communication is off." };
  const template = await db.communicationTemplate.findUnique({ where: { id: setting.templateId } });
  if (!template || template.status !== TemplateStatus.ACTIVE) return { queued: 0, skipped: "Template is not active." };

  const a = await db.assessment.findUniqueOrThrow({
    where: { id: assessmentId },
    select: {
      name: true,
      startAt: true,
      endAt: true,
      durationMinutes: true,
      course: { select: { name: true } },
      batch: { select: { name: true } },
      candidates: {
        where: { learner: { status: UserStatus.ACTIVE } },
        select: { learner: { select: { id: true, name: true, email: true } } },
      },
    },
  });
  const base: VariableValues = {
    assessment_name: a.name,
    course_name: a.course.name,
    batch_name: a.batch?.name ?? "—",
    assessment_start_date: dateFmt.format(a.startAt),
    assessment_start_time: `${timeFmt.format(a.startAt).replace("am", "AM").replace("pm", "PM")} IST`,
    assessment_end_date: dateFmt.format(a.endAt),
    assessment_end_time: `${timeFmt.format(a.endAt).replace("am", "AM").replace("pm", "PM")} IST`,
    assessment_duration: `${a.durationMinutes} minutes`,
    assessment_link: `${env().APP_URL.replace(/\/$/, "")}/login`,
    support_email: template.replyTo ?? template.fromEmail,
    company_name: "Accredian",
  };
  const content = { subject: setting.overrideSubject ?? template.subject, body: setting.overrideBody ?? template.body };
  const toEmail = (learner: { id: string; name: string; email: string }, values: VariableValues, extra: Pick<OutboxEmail, "dedupeKey" | "failure"> = {}): OutboxEmail => {
    const email = renderTemplate(content, { ...base, learner_name: learner.name.split(" ")[0], learner_email: learner.email, ...values });
    return {
      assessmentId,
      event,
      templateId: template.id,
      recipientUserId: learner.id,
      recipientEmail: learner.email,
      subject: email.subject,
      fromName: template.fromName,
      fromEmail: template.fromEmail,
      replyTo: template.replyTo,
      textBody: email.text,
      htmlBody: email.html,
      ...extra,
    };
  };

  let emails: OutboxEmail[];
  if (event === CommunicationEvent.RESULT_PUBLISHED) {
    const appUrl = env().APP_URL.replace(/\/$/, "");
    emails = (await visibleResultsForEmail(assessmentId)).map((r) =>
      toEmail(
        r.learner,
        {
          marks_obtained: String(r.obtained),
          total_marks: String(r.maxMarks),
          percentage: String(r.percentage),
          result_status: r.passed === null ? "Not applicable" : r.passed ? "Pass" : "Fail",
          // The learner's own result page, through sign-in (the page itself checks it is theirs).
          result_url: `${appUrl}/login?next=${encodeURIComponent(`/learner/results/${r.attemptId}`)}`,
        },
        { dedupeKey: `RESULT_PUBLISHED:${r.attemptId}`, failure: VALID_EMAIL.test(r.learner.email) ? null : "The learner has no valid email address." },
      ),
    );
  } else {
    emails = a.candidates.map(({ learner }) => toEmail(learner, {}));
  }
  const recorded = await enqueueEmails(emails);
  const failed = emails.filter((e) => e.failure).length;
  const duplicates = emails.length - recorded;
  await recordAudit({ actorId, action: AuditAction.COMMUNICATION_DISPATCHED, entityType: "Assessment", entityId: assessmentId, metadata: { event, templateId: template.id, queued: recorded, ...(duplicates ? { duplicatesSkipped: duplicates } : {}), ...(failed ? { failed } : {}) } });
  return { queued: recorded, duplicates };
}

/** Communication history (newest first), optionally for one assessment. */
export async function listCommunicationLog(actor: SessionUser, filters: { assessmentId?: string; q?: string } = {}) {
  assertAdmin(actor);
  const q = filters.q?.trim();
  return db.communicationLog.findMany({
    where: {
      ...(filters.assessmentId ? { assessmentId: filters.assessmentId } : {}),
      ...(q ? { OR: [{ recipientEmail: { contains: q, mode: "insensitive" } }, { subject: { contains: q, mode: "insensitive" } }] } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      id: true,
      event: true,
      recipientEmail: true,
      subject: true,
      status: true,
      provider: true,
      error: true,
      createdAt: true,
      assessment: { select: { id: true, name: true, batch: { select: { name: true } } } },
      template: { select: { id: true, name: true } },
    },
  });
}

/** The schedule fields that decide whether a change is a "reschedule" (read before/after an edit). */
export async function scheduleOf(assessmentId: string) {
  return db.assessment.findUnique({ where: { id: assessmentId }, select: { status: true, startAt: true, endAt: true } });
}

/**
 * After a successful action: queue an assessment communication and start delivering it once the
 * response has been sent. Never fails the action.
 */
export async function notify(assessmentId: string, event: CommunicationEventKey, actorId: string | null) {
  try {
    const result = await dispatchAssessmentEvent(assessmentId, event, actorId);
    if (result.queued) scheduleOutboxDelivery();
    return result;
  } catch (err) {
    console.error(`Communication ${event} for assessment ${assessmentId} failed:`, err);
    return null;
  }
}
