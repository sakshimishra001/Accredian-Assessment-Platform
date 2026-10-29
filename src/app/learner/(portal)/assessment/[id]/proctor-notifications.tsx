"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { playTone } from "@/lib/audio/alert-tones";
import { dismissNotification, mergeNotifications, notificationPollMs, type LearnerNotification } from "@/lib/proctoring/notifications";
import { createSeen, notificationChime } from "@/lib/proctoring/sound-alerts";

/*
 * Proctor → learner notifications in the exam (proctor dashboard, phase 8). One-way and
 * informational: shown in a card that never covers the questions or stops anything — answering,
 * autosave, navigation, the timer and submission carry on, and the learner needn't acknowledge.
 *
 * Delivery: the unread ones are loaded when the exam opens; the attempt's notification stream (SSE)
 * announces new ones, which are then fetched (authorized); polling is the fallback — every 15 s
 * without the stream, every 30 s as a safety net with it. Everything stops once the exam closes.
 * Any failure is ignored: the exam never depends on notifications.
 */

/** Refusals that won't change by retrying: signed out, not the learner's attempt. */
const FINAL = new Set([401, 403, 404]);
/** After the stream fails for good, try it again this often (polling covers the gap). */
const RECONNECT_MS = 60_000;

export function useProctorNotifications(attemptId: string, stopped: () => boolean) {
  const [items, setItems] = useState<LearnerNotification[]>([]);
  const dismissed = useRef(new Set<string>());
  const base = `/api/attempts/${encodeURIComponent(attemptId)}/notifications`;
  const stoppedRef = useRef(stopped);
  useEffect(() => {
    stoppedRef.current = stopped;
  });
  // A chime once per newly received notification — not for those already there when the page opens
  // (or reopens), nor again when a poll or a reconnect returns them. Kept across Strict Mode re-runs.
  const [chimes] = useState(createSeen);
  const primed = useRef(false);

  useEffect(() => {
    let done = false;
    let live = false;
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const merge = (incoming: LearnerNotification[]) => {
      setItems((current) => mergeNotifications(current, incoming, dismissed.current));
      if (notificationChime(incoming.map((n) => n.id), chimes, primed.current)) playTone("notification");
    };

    function stop() {
      done = true;
      source?.close();
      if (poll) clearTimeout(poll);
      if (retry) clearTimeout(retry);
    }
    async function loadUnread() {
      if (done) return;
      try {
        const res = await fetch(base, { cache: "no-store" });
        if (FINAL.has(res.status)) return stop();
        const body = (await res.json()) as { ok: boolean; data?: LearnerNotification[] };
        if (!done && body.ok && body.data) {
          merge(body.data);
          // From now on, anything not seen yet is new.
          primed.current = true;
        }
      } catch {
        // Offline for a moment: the next check catches up.
      }
    }
    async function loadOne(id: string) {
      try {
        const res = await fetch(`${base}/${encodeURIComponent(id)}`, { cache: "no-store" });
        const body = (await res.json()) as { ok: boolean; data?: LearnerNotification & { read: boolean } };
        if (!done && body.ok && body.data && !body.data.read) merge([{ id: body.data.id, message: body.data.message, sentAt: body.data.sentAt }]);
      } catch {
        // The next poll picks it up.
      }
    }
    function schedulePoll() {
      if (done) return;
      poll = setTimeout(async () => {
        if (stoppedRef.current()) return stop();
        await loadUnread();
        schedulePoll();
      }, notificationPollMs(live));
    }
    function connect() {
      if (done || typeof EventSource === "undefined") return;
      source = new EventSource(`${base}/stream`);
      source.addEventListener("SNAPSHOT", () => {
        live = true;
        void loadUnread();
      });
      source.addEventListener("PROCTOR_NOTIFICATION", (m) => {
        try {
          const event = JSON.parse((m as MessageEvent<string>).data) as { attemptId?: string; notificationId?: string };
          if (event.notificationId) void loadOne(event.notificationId);
          else void loadUnread();
        } catch {
          void loadUnread();
        }
      });
      source.addEventListener("REVOKED", () => {
        live = false;
        source?.close();
      });
      source.onerror = () => {
        live = false;
        if (!source || source.readyState === EventSource.CLOSED) {
          source?.close();
          if (!done) retry = setTimeout(connect, RECONNECT_MS);
        }
      };
    }

    void loadUnread();
    schedulePoll();
    connect();
    return stop;
  }, [base, chimes]);

  /** "Got it": hide it now and mark it read (best-effort — it stays hidden either way). */
  const acknowledge = useCallback(
    (id: string) => {
      dismissed.current.add(id);
      setItems((current) => dismissNotification(current, id));
      fetch(`${base}/${encodeURIComponent(id)}/read`, { method: "POST" }).catch(() => {});
    },
    [base],
  );

  return { items, acknowledge };
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The newest unread message prominently, earlier unread ones listed below it (a few at most). In a
 * corner, never over the questions' controls; acknowledging is optional.
 */
export function ProctorNotificationCard({
  items,
  onAcknowledge,
  calculatorOpen = false,
}: {
  items: readonly LearnerNotification[];
  onAcknowledge: (id: string) => void;
  /** The calculator occupies the bottom-right corner: the card moves to the top right. */
  calculatorOpen?: boolean;
}) {
  if (items.length === 0) return null;
  const newest = items[items.length - 1];
  const earlier = items.slice(0, -1).reverse();
  return (
    <aside
      role="status"
      aria-live="polite"
      aria-label="Messages from the proctor"
      data-proctor-notifications={items.length}
      className={`fixed right-4 ${calculatorOpen ? "top-16" : "bottom-4"} z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-primary/30 bg-card shadow-lg`}
    >
      <div className="flex items-start gap-3 p-4">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <MessageSquareText className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold tracking-wide text-primary uppercase">Message from Proctor</p>
          <p className="mt-1 text-sm font-medium break-words whitespace-pre-line">{newest.message}</p>
          <p className="mt-1 text-xs text-muted-foreground">Sent {timeOf(newest.sentAt)} · your exam continues</p>
        </div>
        <Button size="sm" onClick={() => onAcknowledge(newest.id)}>
          Got it
        </Button>
      </div>
      {earlier.length ? (
        <ul className="max-h-32 divide-y overflow-y-auto border-t bg-muted/40 text-xs" aria-label="Earlier messages">
          {earlier.map((n) => (
            <li key={n.id} className="flex items-start gap-2 px-4 py-2">
              <span className="min-w-0 flex-1 break-words">
                <span className="text-muted-foreground">{timeOf(n.sentAt)} · </span>
                {n.message}
              </span>
              <button type="button" className="shrink-0 font-medium text-primary hover:underline" onClick={() => onAcknowledge(n.id)}>
                Got it
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}
