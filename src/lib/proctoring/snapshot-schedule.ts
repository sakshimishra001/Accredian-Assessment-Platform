import { SNAPSHOT_WINDOW } from "./evidence";

/*
 * Randomized snapshot timing (proctor dashboard, phase 7), with no DOM of its own. Each snapshot is
 * taken at a random time between the window's minimum and maximum after the previous one — never on
 * a fixed beat, so the learner can't predict it. The first one waits a full random interval after
 * start (a reload never causes an immediate capture). One timer and one capture at a time: no
 * duplicates. When capturing isn't possible (camera off, screen not shared, paused, locked) that
 * slot is skipped and the next one scheduled. A failed capture never throws out of here.
 */

/** A delay in [minMs, maxMs] (ms) from a random number in [0, 1). */
export function nextSnapshotDelay(random: () => number = Math.random, window: { minMs: number; maxMs: number } = SNAPSHOT_WINDOW): number {
  const r = Math.min(Math.max(random(), 0), 0.999999);
  return window.minMs + Math.floor(r * (window.maxMs - window.minMs + 1));
}

export function createSnapshotScheduler(opts: {
  /** Take and upload one snapshot. Its failure is ignored (the next slot is scheduled anyway). */
  capture: () => Promise<unknown>;
  /** Whether a snapshot can be taken now (attempt running, camera on / screen shared, permission granted). */
  canCapture: () => boolean;
  random?: () => number;
  window?: { minMs: number; maxMs: number };
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let inFlight = false;

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void fire(), nextSnapshotDelay(opts.random, opts.window));
  }

  async function fire() {
    timer = null;
    if (!running) return;
    if (!inFlight && opts.canCapture()) {
      inFlight = true;
      try {
        await opts.capture();
      } catch {
        // Evidence is supplementary: the exam carries on.
      } finally {
        inFlight = false;
      }
    }
    if (running && !timer) schedule();
  }

  return {
    /** Start (idempotent): the first snapshot comes after a random interval, not straight away. */
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    /** Stop and clear the timer (idempotent). */
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    isRunning: () => running,
    /** Whether a snapshot is scheduled. */
    scheduled: () => timer !== null,
  };
}
