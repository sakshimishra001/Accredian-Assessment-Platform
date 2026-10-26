/*
 * The monitoring event bus (proctor dashboard, phase 5): an in-process publish / subscribe channel
 * per assessment. It carries *that something changed* — never learner data — so a proctor's
 * dashboard can reload the authoritative state from the database straight away instead of waiting
 * for its next poll. Nothing is persisted or buffered: an event reaches only the subscribers present
 * when it is published, and a subscriber that misses one still sees the change on its next reload.
 *
 * Single-server limitation: subscribers only receive events published by the same server process.
 * With several instances (or serverless functions) an event published on one isn't seen by
 * subscribers on another — the dashboard's polling fallback covers that. A shared channel (e.g.
 * Postgres LISTEN/NOTIFY or Redis) would be needed to fan out across instances.
 */

import type { MonitoringEvent } from "@/lib/proctoring/monitoring-events";

export { MONITORING_EVENT_TYPES, type MonitoringEvent, type MonitoringEventType } from "@/lib/proctoring/monitoring-events";

export type MonitoringListener = (event: MonitoringEvent) => void;

/** Subscribers per assessment, at most; beyond it, subscribing is refused (the client then polls). */
export const MAX_SUBSCRIBERS_PER_ASSESSMENT = 200;

export class SubscriberLimitError extends Error {
  constructor() {
    super("Too many live connections for this assessment.");
  }
}

export function createMonitoringBus(opts: { maxPerAssessment?: number; topicOf?: (event: MonitoringEvent) => string | null } = {}) {
  const max = opts.maxPerAssessment ?? MAX_SUBSCRIBERS_PER_ASSESSMENT;
  // Subscribers listen to a topic: the event's assessment, unless the bus is keyed otherwise.
  const topicOf = opts.topicOf ?? ((e: MonitoringEvent) => e.assessmentId);
  const topics = new Map<string, Set<MonitoringListener>>();
  return {
    /** Listen to one assessment's events. Returns `unsubscribe` (idempotent); call it when the client goes away. */
    subscribe(assessmentId: string, listener: MonitoringListener): () => void {
      let set = topics.get(assessmentId);
      if (!set) topics.set(assessmentId, (set = new Set()));
      if (set.size >= max) throw new SubscriberLimitError();
      set.add(listener);
      return () => {
        const current = topics.get(assessmentId);
        if (!current) return;
        current.delete(listener);
        // No empty topics left behind.
        if (current.size === 0) topics.delete(assessmentId);
      };
    },
    /** Deliver to that assessment's subscribers only. A failing subscriber never affects the others or the publisher. */
    publish(event: MonitoringEvent) {
      const topic = topicOf(event);
      const set = topic ? topics.get(topic) : undefined;
      if (!set) return;
      for (const listener of [...set]) {
        try {
          listener(event);
        } catch {
          // A broken connection is cleaned up by its own disconnect handling.
        }
      }
    },
    subscriberCount(assessmentId?: string) {
      if (assessmentId) return topics.get(assessmentId)?.size ?? 0;
      let n = 0;
      for (const s of topics.values()) n += s.size;
      return n;
    },
    topicCount: () => topics.size,
  };
}

export type MonitoringBus = ReturnType<typeof createMonitoringBus>;

/** Learner exam pages listening for notifications, per attempt, at most (several tabs). */
export const MAX_LEARNER_STREAMS_PER_ATTEMPT = 3;

// One bus per server process (kept on globalThis so development hot reloads don't split it).
const g = globalThis as typeof globalThis & { __monitoringBus?: MonitoringBus; __learnerNotificationBus?: MonitoringBus };
export const monitoringBus: MonitoringBus = (g.__monitoringBus ??= createMonitoringBus());

/**
 * Proctor → learner notifications (phase 8) for the learner's own exam page: the same bus, keyed by
 * attempt, carrying only PROCTOR_NOTIFICATION events (publish.ts) — a learner never sees another
 * attempt's events, and learner pages don't count against the proctors' per-assessment limit.
 */
export const learnerNotificationBus: MonitoringBus = (g.__learnerNotificationBus ??= createMonitoringBus({
  maxPerAssessment: MAX_LEARNER_STREAMS_PER_ATTEMPT,
  topicOf: (e) => (e.type === "PROCTOR_NOTIFICATION" ? e.attemptId : null),
}));
