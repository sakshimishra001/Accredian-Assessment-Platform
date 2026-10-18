import "server-only";
import { after } from "next/server";
import type { CommunicationEvent } from "@/generated/prisma/enums";
import { DeliveryStatus } from "@/generated/prisma/enums";
import { db } from "../db";
import { emailProvider } from "./index";

/*
 * Database-backed email outbox. A request only records each rendered email as a PENDING row in
 * communication_logs and returns. Delivery happens afterwards: right after the response (Next.js
 * after()) and from the standalone worker (`npm run outbox:work`), which also picks up retries.
 *
 * Workers claim rows atomically (FOR UPDATE SKIP LOCKED), marking them SENDING with a lease, so
 * several processes never send the same email twice; a row whose worker died is taken over once
 * its lease has passed. A provider failure is retried with exponential backoff up to
 * OUTBOX_MAX_ATTEMPTS, then the row is FAILED. "outbox" (no email service) records NOT_DELIVERED.
 */

export const OUTBOX_MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

/** Wait before retry n (n = attempts made so far): 1, 2, 4, 8 … minutes, at most an hour. */
export function retryDelayMs(attempts: number) {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

export interface OutboxEmail {
  assessmentId?: string | null;
  event?: CommunicationEvent | null;
  templateId?: string | null;
  recipientUserId?: string | null;
  recipientEmail: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string | null;
  textBody: string;
  htmlBody: string;
  /** Once-only emails: a second email with the same key is skipped (unique in the database). */
  dedupeKey?: string | null;
  /** Can't be sent at all (e.g. no valid address): recorded straight away as FAILED with this reason. */
  failure?: string | null;
}

/**
 * Record emails for delivery. Nothing is sent here. Emails whose dedupeKey is already recorded are
 * skipped, even under concurrent calls; returns how many rows were recorded.
 */
export async function enqueueEmails(emails: OutboxEmail[], now: Date = new Date()) {
  if (emails.length === 0) return 0;
  const { count } = await db.communicationLog.createMany({
    data: emails.map(({ failure, ...e }) => (failure ? { ...e, status: DeliveryStatus.FAILED, error: failure } : { ...e, status: DeliveryStatus.PENDING, nextAttemptAt: now })),
    skipDuplicates: true,
  });
  return count;
}

/** Atomically claim up to `limit` due rows for this worker. */
async function claim(limit: number, now: Date): Promise<string[]> {
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "communication_logs"
       SET "status" = 'SENDING', "lockedUntil" = ${leaseUntil}, "attempts" = "attempts" + 1, "lastAttemptAt" = ${now}
     WHERE "id" IN (
       SELECT "id" FROM "communication_logs"
        WHERE ("status" = 'PENDING' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now}))
           OR ("status" = 'SENDING' AND "lockedUntil" < ${now})
        ORDER BY "createdAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING "id"`;
  return rows.map((r) => r.id);
}

export interface DeliveryRun {
  claimed: number;
  sent: number;
  notDelivered: number;
  retrying: number;
  failed: number;
}

/** Deliver due emails through the configured provider and record each outcome. */
export async function deliverPendingEmails(options: { limit?: number; now?: Date } = {}): Promise<DeliveryRun> {
  const now = options.now ?? new Date();
  const ids = await claim(options.limit ?? 100, now);
  const run: DeliveryRun = { claimed: ids.length, sent: 0, notDelivered: 0, retrying: 0, failed: 0 };
  const provider = emailProvider();

  for (const id of ids) {
    const row = await db.communicationLog.findUnique({ where: { id } });
    if (!row || row.status !== DeliveryStatus.SENDING) continue;
    let outcome;
    try {
      outcome = await provider.send({
        to: row.recipientEmail,
        from: { name: row.fromName ?? "", email: row.fromEmail ?? "" },
        replyTo: row.replyTo,
        subject: row.subject,
        text: row.textBody ?? "",
        html: row.htmlBody ?? "",
      });
    } catch (err) {
      outcome = { status: "FAILED" as const, error: err instanceof Error ? err.message : "Unknown error" };
    }
    const done = { provider: provider.name, lockedUntil: null };
    if (outcome.status === "SENT") {
      run.sent++;
      await db.communicationLog.update({ where: { id }, data: { ...done, status: DeliveryStatus.SENT, providerMessageId: outcome.messageId, deliveredAt: new Date(), error: null } });
    } else if (outcome.status === "NOT_DELIVERED") {
      run.notDelivered++;
      await db.communicationLog.update({ where: { id }, data: { ...done, status: DeliveryStatus.NOT_DELIVERED, error: outcome.reason } });
    } else if (row.attempts >= OUTBOX_MAX_ATTEMPTS) {
      run.failed++;
      await db.communicationLog.update({ where: { id }, data: { ...done, status: DeliveryStatus.FAILED, error: outcome.error.slice(0, 1000) } });
    } else {
      run.retrying++;
      await db.communicationLog.update({
        where: { id },
        data: { ...done, status: DeliveryStatus.PENDING, nextAttemptAt: new Date(now.getTime() + retryDelayMs(row.attempts)), error: outcome.error.slice(0, 1000) },
      });
    }
  }
  return run;
}

/**
 * Start delivering right after the current response is sent. Outside a request (tests, scripts)
 * there is nothing to schedule on; the worker delivers instead.
 */
export function scheduleOutboxDelivery() {
  try {
    after(() => deliverPendingEmails().catch((err) => console.error("Email outbox delivery failed:", err)));
  } catch {
    // Not inside a request.
  }
}
