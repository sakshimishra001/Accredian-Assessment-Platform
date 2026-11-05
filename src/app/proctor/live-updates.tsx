"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { AlertTriangle, Radio, RefreshCw, Volume2, VolumeX, X } from "lucide-react";
import { playTone, unlockAudio, unlockAudioOnFirstInteraction } from "@/lib/audio/alert-tones";
import { affectsView, MONITORING_EVENT_TYPES, pollIntervalMs, STREAM_REVOKED, STREAM_SNAPSHOT, type LiveStatus, type MonitoringEvent } from "@/lib/proctoring/monitoring-events";
import { createSeen, parseSoundPreference, PROCTOR_SOUND_KEY, proctorViolationDecision, upsertAlert, VIOLATION_ALERT_TEXT, type ProctorViolationNotice } from "@/lib/proctoring/sound-alerts";
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
  // Each live violation alerts once (the same event never twice: re-renders, Strict Mode, reconnects).
  const [violationSounds] = useState(createSeen);
  // On-screen violation alerts (newest first), shown whether or not sound is on; each stays until dismissed.
  const [alerts, setAlerts] = useState<ProctorViolationNotice[]>([]);
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

    /** Show the alert at once, then fill in who / what / count from the authorized details. */
    function showViolation(eventAttemptId: string, at: string, eventId?: string) {
      const key = eventId ?? `${eventAttemptId}:${at}`;
      setAlerts((list) => upsertAlert(list, { key, attemptId: eventAttemptId, at, learnerName: null, what: "Proctoring violation", violation: null, max: null }));
      if (!eventId) return;
      const url = `/api/proctor/assessments/${encodeURIComponent(assessmentId)}/attempts/${encodeURIComponent(eventAttemptId)}/violations/${encodeURIComponent(eventId)}`;
      fetch(url, { cache: "no-store" })
        .then((r) => r.json())
        .then((body: { ok: boolean; data?: { learnerName: string; eventType: string; at: string; violation: number | null; max: number } }) => {
          const d = body.ok ? body.data : null;
          if (stopped || !d) return;
          setAlerts((list) =>
            list.some((a) => a.key === key)
              ? upsertAlert(list, { key, attemptId: eventAttemptId, at: d.at, learnerName: d.learnerName, what: VIOLATION_ALERT_TEXT[d.eventType] ?? "Proctoring violation", violation: d.violation, max: d.max })
              : list,
          );
        })
        .catch(() => {
          // The alert stays with what the live event said.
        });
    }

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
            // A new counted violation for any learner of this assessment: an on-screen alert, and the
            // warning sound if switched on — never for anything that happened before the page loaded.
            const decision = proctorViolationDecision(event, soundEnabled(), violationSounds);
            if (decision.sound) playTone("proctor-violation");
            if (decision.visual && event.attemptId) showViolation(event.attemptId, event.at, event.eventId);
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
    if (on) void unlockAudio().then(() => playTone("proctor-violation"));
  }
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={toggleSound}
        aria-pressed={soundOn}
        title="Play a warning sound when a learner commits a counted violation (the on-screen alert shows either way)"
        className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        data-sound-alerts={soundOn ? "on" : "off"}
      >
        {soundOn ? <Volume2 className="size-3.5 text-primary" aria-hidden /> : <VolumeX className="size-3.5" aria-hidden />}
        Sound alerts: {soundOn ? "On" : "Off"}
      </button>
      <ViolationAlerts assessmentId={assessmentId} alerts={alerts} onDismiss={(key) => setAlerts((list) => list.filter((a) => a.key !== key))} />
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

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

/**
 * Live counted-violation alerts for the proctor: prominent cards at the top right, newest first —
 * learner, what happened, when (IST) and the count — each opening that learner's attempt page. They
 * show whether or not sound alerts are on, and stay until dismissed.
 */
function ViolationAlerts({ assessmentId, alerts, onDismiss }: { assessmentId: string; alerts: readonly ProctorViolationNotice[]; onDismiss: (key: string) => void }) {
  if (alerts.length === 0) return null;
  return (
    <span role="alert" aria-live="assertive" className="fixed top-16 right-4 z-50 grid w-[min(24rem,calc(100vw-2rem))] gap-2" data-violation-alerts={alerts.length}>
      {alerts.map((a) => (
        <span key={a.key} className="relative block overflow-hidden rounded-xl border-2 border-red-600 bg-card text-left shadow-2xl">
          <Link href={`/proctor/assessments/${assessmentId}/attempts/${a.attemptId}`} className="block hover:bg-red-50/60">
            <span className="flex items-center gap-2 bg-red-600 px-3 py-1.5 text-xs font-bold tracking-wider text-white uppercase">
              <AlertTriangle className="size-4" aria-hidden /> Proctoring violation
            </span>
            <span className="grid gap-0.5 px-3 py-2.5 pr-9">
              <span className="text-base font-semibold text-foreground">{a.learnerName ?? "A learner"}</span>
              <span className="text-sm text-foreground">{a.what}</span>
              <span className="text-xs text-muted-foreground">
                {timeOf(a.at)} IST{a.violation !== null && a.max ? ` · Violation ${a.violation} of ${a.max}` : ""}
              </span>
            </span>
          </Link>
          <button type="button" onClick={() => onDismiss(a.key)} className="absolute top-9 right-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Dismiss alert">
            <X className="size-4" aria-hidden />
          </button>
        </span>
      ))}
    </span>
  );
}
