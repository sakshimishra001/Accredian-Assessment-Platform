"use client";

import { useEffect } from "react";
import { PRESENCE_HEARTBEAT_MS } from "@/lib/proctoring/presence";

/** Refusals that won't change by retrying: signed out, not the learner's, attempt no longer running. */
const FINAL = new Set([401, 403, 404, 409]);

/**
 * Tell the server the exam page is open (proctor dashboard presence, phase 6): a heartbeat every
 * ~20 s while the attempt runs, and "leaving" when the page closes or the attempt is locked, ends
 * or is refused. Connection status only — never a violation. Best-effort: a failed request is
 * ignored (the next one catches up) and the exam never waits for or depends on it.
 */
export function usePresenceHeartbeat(attemptId: string, stopped: () => boolean) {
  useEffect(() => {
    const url = `/api/attempts/${encodeURIComponent(attemptId)}/presence`;
    // Tells this page apart from another one (a reload, a second tab) for the same attempt.
    const connectionId = crypto.randomUUID();
    const body = JSON.stringify({ connectionId });
    let done = false;
    let left = false;

    function leave() {
      if (left) return;
      left = true;
      // keepalive: still sent while the page unloads.
      fetch(url, { method: "DELETE", keepalive: true, headers: { "Content-Type": "application/json" }, body }).catch(() => {});
    }
    function stop() {
      if (done) return;
      done = true;
      clearInterval(timer);
      leave();
    }
    async function beat() {
      if (done) return;
      if (stopped()) return stop();
      left = false;
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
        if (FINAL.has(res.status)) stop();
      } catch {
        // Offline for a moment: the next heartbeat catches up.
      }
    }

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
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one heartbeat per attempt; `stopped` reads refs
  }, [attemptId]);
}
