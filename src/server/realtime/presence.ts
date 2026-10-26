/*
 * Learner presence (proctor dashboard, phase 6): whether a learner's exam page is connected right
 * now, from the page's heartbeats. Operational status only — never a proctoring violation, never
 * a reason to lock or terminate, and it doesn't touch the attempt's timing or lastActivityAt.
 *
 * Kept in memory only (never in the database), one record per running attempt, holding just the
 * attempt, assessment and learner ids, when the last heartbeat arrived and which page sent it. A
 * learner is online while a heartbeat arrived within PRESENCE_OFFLINE_AFTER_MS (a few heartbeat
 * intervals, so one failed request doesn't make them offline). LEARNER_ONLINE is published when a
 * learner comes (back) online, LEARNER_OFFLINE when they go offline — by the sweep, or when the page
 * says it is closing. Records are forgotten once the attempt ends, or once stale beyond a grace
 * period; their number is capped.
 *
 * Single-server limitation: like the event bus, the store is per server process. With several
 * instances (or serverless functions) each sees only the heartbeats it received, so a learner may
 * look offline on one while online on another, and the sweep only runs while the process is alive.
 * Online / offline is therefore always computed from lastSeenAt when read, never only from events.
 */

import { monitoringBus, type MonitoringBus } from "./bus";

import { NO_MONITORING, sameStatus, type MonitoringStatus } from "@/lib/proctoring/monitoring-status";
import { PRESENCE_OFFLINE_AFTER_MS } from "@/lib/proctoring/presence";

export { PRESENCE_HEARTBEAT_MS, PRESENCE_OFFLINE_AFTER_MS } from "@/lib/proctoring/presence";
/** Offline records are kept this much longer (for "last seen"), then forgotten. */
export const PRESENCE_FORGET_AFTER_MS = 30 * 60_000;
/** How often stale records are checked. */
export const PRESENCE_SWEEP_MS = 15_000;
/** At most this many records (one per running attempt); beyond it new learners aren't tracked. */
export const MAX_PRESENCE_RECORDS = 20_000;

export interface PresenceRecord {
  attemptId: string;
  assessmentId: string;
  learnerId: string;
  lastSeenAt: number;
  /** The exam page that sent the last heartbeat (a random id per page load). */
  connectionId: string;
  /** Whether LEARNER_ONLINE (rather than LEARNER_OFFLINE) was the last event published. */
  online: boolean;
  /** Camera / face / screen state as last reported by the exam page (phase 7). */
  status: MonitoringStatus;
}

export interface Presence {
  online: boolean;
  lastSeenAt: Date;
  /** As last reported; meaningful only while online. */
  status: MonitoringStatus;
}

export function createPresenceStore(opts: {
  bus: MonitoringBus;
  offlineAfterMs?: number;
  forgetAfterMs?: number;
  sweepMs?: number;
  maxRecords?: number;
  clock?: () => number;
}) {
  const offlineAfter = opts.offlineAfterMs ?? PRESENCE_OFFLINE_AFTER_MS;
  const forgetAfter = opts.forgetAfterMs ?? PRESENCE_FORGET_AFTER_MS;
  const sweepMs = opts.sweepMs ?? PRESENCE_SWEEP_MS;
  const max = opts.maxRecords ?? MAX_PRESENCE_RECORDS;
  const clock = opts.clock ?? Date.now;
  const records = new Map<string, PresenceRecord>();
  let sweeper: ReturnType<typeof setInterval> | null = null;

  const fresh = (r: PresenceRecord, now: number) => now - r.lastSeenAt <= offlineAfter;

  function publish(type: "LEARNER_ONLINE" | "LEARNER_OFFLINE" | "PROCTORING_STATUS_CHANGED", r: PresenceRecord, now: number) {
    try {
      opts.bus.publish({ type, assessmentId: r.assessmentId, attemptId: r.attemptId, at: new Date(now).toISOString() });
    } catch {
      // Best-effort: dashboards also poll.
    }
  }

  /** Mark stale learners offline (publishing LEARNER_OFFLINE) and forget long-stale records. */
  function sweep(now = clock()) {
    for (const r of [...records.values()]) {
      if (r.online && !fresh(r, now)) {
        r.online = false;
        publish("LEARNER_OFFLINE", r, now);
      }
      if (now - r.lastSeenAt > offlineAfter + forgetAfter) records.delete(r.attemptId);
    }
    if (records.size === 0) stopSweeper();
  }

  function startSweeper() {
    if (sweeper) return;
    sweeper = setInterval(() => sweep(), sweepMs);
    // Never keeps the process alive on its own.
    (sweeper as { unref?: () => void }).unref?.();
  }
  function stopSweeper() {
    if (sweeper) clearInterval(sweeper);
    sweeper = null;
  }

  return {
    /**
     * A heartbeat from the learner's exam page (the caller has checked it is the learner's own running
     * attempt), with its camera / face / screen state when it reports one. Returns whether it is
     * tracked (false only when the store is full).
     */
    heartbeat(r: { attemptId: string; assessmentId: string; learnerId: string; connectionId: string }, status?: MonitoringStatus) {
      const now = clock();
      let record = records.get(r.attemptId);
      if (!record) {
        if (records.size >= max) sweep(now);
        if (records.size >= max) return false;
        record = { ...r, lastSeenAt: now, online: false, status: NO_MONITORING };
        records.set(r.attemptId, record);
      }
      // An attempt never changes assessment or learner; a mismatch is ignored rather than trusted.
      if (record.assessmentId !== r.assessmentId || record.learnerId !== r.learnerId) return false;
      const wasOnline = record.online && fresh(record, now);
      record.lastSeenAt = now;
      record.connectionId = r.connectionId;
      record.online = true;
      const changed = !!status && !sameStatus(status, record.status);
      if (status) record.status = status;
      if (!wasOnline) publish("LEARNER_ONLINE", record, now);
      // Coming online already makes dashboards reload; otherwise say the state changed.
      else if (changed) publish("PROCTORING_STATUS_CHANGED", record, now);
      startSweeper();
      return true;
    },

    /**
     * The exam page is closing. Offline at once — unless a newer page (a reload, another tab) has
     * sent a heartbeat since, which this stale page must not override.
     */
    leave(attemptId: string, connectionId: string) {
      const record = records.get(attemptId);
      if (!record || record.connectionId !== connectionId || !record.online) return;
      record.online = false;
      publish("LEARNER_OFFLINE", record, clock());
    },

    /** The attempt ended (submitted, terminated): nothing to show as online any more. */
    forget(attemptId: string) {
      records.delete(attemptId);
      if (records.size === 0) stopSweeper();
    },

    /** The learner's presence for an attempt, computed now; null when never seen (or forgotten). */
    get(attemptId: string): Presence | null {
      const r = records.get(attemptId);
      if (!r) return null;
      return { online: r.online && fresh(r, clock()), lastSeenAt: new Date(r.lastSeenAt), status: r.status };
    },

    sweep,
    size: () => records.size,
    sweeping: () => sweeper !== null,
    /** Stop the sweeper and forget everything (tests). */
    clear() {
      records.clear();
      stopSweeper();
    },
  };
}

export type PresenceStore = ReturnType<typeof createPresenceStore>;

// One store per server process (kept on globalThis so development hot reloads don't split it).
const g = globalThis as typeof globalThis & { __presenceStore?: PresenceStore };
export const presenceStore: PresenceStore = (g.__presenceStore ??= createPresenceStore({ bus: monitoringBus }));
