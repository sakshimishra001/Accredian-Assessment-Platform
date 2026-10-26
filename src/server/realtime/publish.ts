import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { db, type DbTx } from "../db";
import { monitoringBus, type MonitoringEvent, type MonitoringEventType } from "./bus";
import { presenceStore } from "./presence";

/*
 * Publishing monitoring events only for state that is really in the database. Services emit inside
 * their transaction (where they know the change happened); the events are held and published once
 * the transaction has committed — a rolled-back transaction (one that throws) publishes nothing.
 * Each event is emitted only where the state actually changed (a repeated submit, lock or terminate
 * that changes nothing emits nothing), and one transaction publishes each (type, attempt) once.
 */

const pending = new AsyncLocalStorage<MonitoringEvent[]>();

const ATTEMPT_ENDED: ReadonlySet<MonitoringEventType> = new Set(["ATTEMPT_SUBMITTED", "ATTEMPT_AUTO_SUBMITTED", "ATTEMPT_TERMINATED"]);

/** Record that something changed. Inside `transaction` it waits for the commit; outside, it is published now. */
export function emitMonitoringEvent(
  type: MonitoringEventType,
  assessmentId: string,
  attemptId: string | null = null,
  now: Date = new Date(),
  evidence?: { evidenceId: string; evidenceType: "CAMERA" | "SCREEN" },
) {
  const event: MonitoringEvent = { type, assessmentId, attemptId, at: now.toISOString(), ...evidence };
  const queue = pending.getStore();
  if (queue) queue.push(event);
  else publishSafely([event]);
}

function publishSafely(events: MonitoringEvent[]) {
  const seen = new Set<string>();
  for (const e of events) {
    const key = `${e.type}:${e.assessmentId}:${e.attemptId ?? ""}:${e.evidenceId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      // An ended attempt's learner is no longer "online" (presence, phase 6).
      if (e.attemptId && ATTEMPT_ENDED.has(e.type)) presenceStore.forget(e.attemptId);
      monitoringBus.publish(e);
    } catch {
      // Live updates are best-effort: the database is the source of truth and dashboards also poll.
    }
  }
}

/** Run `work`; monitoring events emitted inside are published only if it completes without throwing. */
export async function withMonitoringEvents<T>(work: () => Promise<T>): Promise<T> {
  const queue: MonitoringEvent[] = [];
  const result = await pending.run(queue, work);
  publishSafely(queue);
  return result;
}

/** db.$transaction, with monitoring events emitted inside it published after it commits. */
export function transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
  return withMonitoringEvents(() => db.$transaction(fn));
}
