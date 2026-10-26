"use client";

import { useCallback, useEffect, useRef } from "react";
import type { MonitoringStatus } from "@/lib/proctoring/monitoring-status";
import { PRESENCE_HEARTBEAT_MS } from "@/lib/proctoring/presence";

/** Refusals that won't change by retrying: signed out, not the learner's, attempt no longer running. */
const FINAL = new Set([401, 403, 404, 409]);
/** A status change is sent this long after it happens (several changes in a row: one heartbeat)… */
const NOTIFY_DELAY_MS = 2_000;
/** …and no more often than this. */
const NOTIFY_MIN_GAP_MS = 5_000;

/**
 * Tell the server the exam page is open (proctor dashboard presence, phase 6): a heartbeat every
 * ~20 s while the attempt runs, and "leaving" when the page closes or the attempt is locked, ends
 * or is refused. Connection status only — never a violation. Best-effort: a failed request is
 * ignored (the next one catches up) and the exam never waits for or depends on it.
 *
 * With `status` (phase 7) each heartbeat also carries the camera / face / screen state; the returned
 * `notify()` sends it soon after it changes rather than at the next heartbeat.
 */
export function usePresenceHeartbeat(attemptId: string, stopped: () => boolean, status?: () => MonitoringStatus): () => void {
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  });
  const notifyRef = useRef<() => void>(() => {});

  useEffect(() => {
    const url = `/api/attempts/${encodeURIComponent(attemptId)}/presence`;
    // Tells this page apart from another one (a reload, a second tab) for the same attempt.
    const connectionId = crypto.randomUUID();
    let done = false;
    let left = false;
    let lastSent = 0;
    let soon: ReturnType<typeof setTimeout> | null = null;
    const body = () => JSON.stringify(statusRef.current ? { connectionId, status: statusRef.current() } : { connectionId });

    function leave() {
      if (left) return;
      left = true;
      // keepalive: still sent while the page unloads.
      fetch(url, { method: "DELETE", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId }) }).catch(() => {});
    }
    function stop() {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (soon) clearTimeout(soon);
      leave();
    }
    async function beat() {
      if (done) return;
      if (stopped()) return stop();
      left = false;
      lastSent = Date.now();
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body() });
        if (FINAL.has(res.status)) stop();
      } catch {
        // Offline for a moment: the next heartbeat catches up.
      }
    }
    notifyRef.current = () => {
      if (done || soon) return;
      const wait = Math.max(NOTIFY_DELAY_MS, lastSent + NOTIFY_MIN_GAP_MS - Date.now());
      soon = setTimeout(() => {
        soon = null;
        void beat();
      }, wait);
    };

    const timer = setInterval(() => void beat(), PRESENCE_HEARTBEAT_MS);
    void beat();
    const onHide = () => leave();
    // Back from the browser's page cache, or the page shown again: say so straight away.
    const onShow = () => void beat();
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      notifyRef.current = () => {};
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one heartbeat per attempt; `stopped` reads refs
  }, [attemptId]);

  return useCallback(() => notifyRef.current(), []);
}
