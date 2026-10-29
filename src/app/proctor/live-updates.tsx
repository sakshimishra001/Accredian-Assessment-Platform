"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Radio, RefreshCw, Volume2, VolumeX } from "lucide-react";
import { playTone, unlockAudio, unlockAudioOnFirstInteraction } from "@/lib/audio/alert-tones";
import { affectsView, MONITORING_EVENT_TYPES, pollIntervalMs, STREAM_REVOKED, STREAM_SNAPSHOT, type LiveStatus, type MonitoringEvent } from "@/lib/proctoring/monitoring-events";
import { createSeen, parseSoundPreference, PROCTOR_SOUND_KEY, proctorViolationAlert } from "@/lib/proctoring/sound-alerts";
import { formatDateTime } from "@/prototype/lib/format";

/** Several events in quick succession cause one reload. */
const DEBOUNCE_MS = 400;
/** After the stream fails for good (e.g. refused), try again this often — polling covers the gap. */
const RECONNECT_MS = 60_000;

const noSubscription = () => () => {};

// The proctor's "Sound alerts" preference: this browser only (localStorage), off until switched on.
const soundListeners = new Set<() => void>();
function soundEnabled(): boolean {
  try {
    return parseSoundPreference(localStorage.getItem(PROCTOR_SOUND_KEY));
  } catch {
    return false;
  }
}
function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(PROCTOR_SOUND_KEY, on ? "on" : "off");
  } catch {
    // Not stored (private mode): it applies to this page only.
  }
  for (const l of soundListeners) l();
}
function subscribeSound(listener: () => void) {
  soundListeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === PROCTOR_SOUND_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    soundListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
/** Whether this browser has EventSource (assumed yes while rendering on the server). */
const useEventSourceSupported = () => useSyncExternalStore(noSubscription, () => typeof EventSource !== "undefined", () => true);

/**
 * Live updates for a proctor page (proctor dashboard, phase 5). Server-Sent Events from
 * /api/proctor/assessments/[id]/stream make the page reload its data from the server as soon as
 * something changes (an attempt starts, a violation, a lock, a submission…); polling stays on as a
 * fallback — every 20 s while the stream isn't connected, and every minute as a safety net while it
 * is (an event published on another server instance never reaches this one). Every reload re-runs
 * the server's authorization. The learner's exam never depends on this.
 */
export function LiveUpdates({ assessmentId, attemptId = null, asOf }: { assessmentId: string; attemptId?: string | null; asOf: Date }) {
  const router = useRouter();
  const supported = useEventSourceSupported();
  const soundOn = useSyncExternalStore(subscribeSound, soundEnabled, () => false);
  // Each live violation sounds once (the same event never twice: re-renders, Strict Mode, reconnects).
  const [violationSounds] = useState(createSeen);
  // A preference saved earlier: sound becomes possible at the page's first interaction (browser rule).
  useEffect(() => (soundOn ? unlockAudioOnFirstInteraction() : undefined), [soundOn]);
  const [streamStatus, setStatus] = useState<LiveStatus>("connecting");
  // No EventSource in this browser: polling only.
  const status: LiveStatus = supported ? streamStatus : "polling";
  const [refreshingFrom, setRefreshingFrom] = useState<number | null>(null);
  const asOfMs = asOf.getTime();
  const current = useRef(asOfMs);
  useEffect(() => {
    current.current = asOfMs;
  }, [asOfMs]);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    refreshRef.current = () => {
      setRefreshingFrom(current.current);
      router.refresh();
    };
  });

  // The event stream (with automatic reconnects).
  useEffect(() => {
    if (!supported) return;
    let stopped = false;
    let source: EventSource | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const refreshSoon = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => refreshRef.current(), DEBOUNCE_MS);
    };

    function connect() {
      if (stopped) return;
      source = new EventSource(`/api/proctor/assessments/${encodeURIComponent(assessmentId)}/stream`);
      // Connected: load the authoritative state (anything may have changed since the page rendered).
      source.addEventListener(STREAM_SNAPSHOT, () => {
        setStatus("live");
        refreshSoon();
      });
      for (const type of MONITORING_EVENT_TYPES) {
        source.addEventListener(type, (m) => {
          try {
            const event = JSON.parse((m as MessageEvent<string>).data) as MonitoringEvent;
            // A new counted violation for any learner of this assessment: the warning sound, if switched on.
            if (proctorViolationAlert(event, soundEnabled(), violationSounds)) playTone("violation");
            if (affectsView(event, attemptId)) refreshSoon();
          } catch {
            refreshSoon();
          }
        });
      }
      // Access ended (unassigned, signed out): stop streaming; the reload shows what the server allows.
      source.addEventListener(STREAM_REVOKED, () => {
        source?.close();
        stopped = true;
        setStatus("polling");
        refreshRef.current();
      });
      source.onerror = () => {
        if (!source || source.readyState === EventSource.CLOSED) {
          // Refused or failed for good: poll, and try again later.
          setStatus("polling");
          source?.close();
          if (!stopped) retry = setTimeout(connect, RECONNECT_MS);
        } else {
          // The browser is reconnecting on its own; poll meanwhile.
          setStatus("connecting");
        }
      };
    }
    connect();
    return () => {
      stopped = true;
      source?.close();
      if (debounce) clearTimeout(debounce);
      if (retry) clearTimeout(retry);
    };
  }, [assessmentId, attemptId, supported, violationSounds]);

  // Polling fallback (and safety net), only while the tab is visible.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refreshRef.current();
    }, pollIntervalMs(status));
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [status]);

  const refreshing = refreshingFrom === asOfMs;
  function toggleSound() {
    const on = !soundOn;
    setSoundEnabled(on);
    // This click is the interaction browsers require: enable audio and play the alert once as a check.
    if (on) void unlockAudio().then(() => playTone("violation"));
  }
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={toggleSound}
        aria-pressed={soundOn}
        title="Play a short warning sound when a learner commits a counted violation"
        className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        data-sound-alerts={soundOn ? "on" : "off"}
      >
        {soundOn ? <Volume2 className="size-3.5 text-primary" aria-hidden /> : <VolumeX className="size-3.5" aria-hidden />}
        Sound alerts: {soundOn ? "On" : "Off"}
      </button>
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite" data-live-status={status}>
        {status === "live" ? (
          <Radio className="size-3.5 text-emerald-600" aria-hidden />
        ) : (
          <RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
        )}
        {status === "live" ? "Live" : status === "connecting" ? "Connecting…" : `Refreshing every ${pollIntervalMs(status) / 1000}s`}
        {" · "}updated {formatDateTime(asOf.toISOString())} IST
      </span>
    </span>
  );
}
