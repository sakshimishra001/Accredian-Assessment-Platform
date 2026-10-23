import { STREAM_REVOKED, STREAM_SNAPSHOT, type MonitoringEvent } from "@/lib/proctoring/monitoring-events";
import type { MonitoringBus } from "./bus";

/*
 * A Server-Sent Events stream of one assessment's monitoring events for one proctor dashboard.
 *
 * - First a SNAPSHOT message: the client then reloads the authoritative state, which covers anything
 *   that changed between rendering its page and connecting.
 * - Then that assessment's events only (the subscription is keyed by the server-verified assessment).
 * - A comment line every `heartbeatMs`, so proxies and browsers don't drop an idle connection.
 * - Every `recheckMs` the viewer's access is checked again (session, role, assignment); when it no
 *   longer holds, a REVOKED message is sent and the stream ends.
 * - After `maxLifetimeMs` the stream ends on its own (before a hosting time limit would cut it); the
 *   browser's EventSource reconnects, which authorizes afresh.
 * Whatever ends it — the client leaving, revocation, the lifetime — the subscription and every timer
 * are released. Nothing about the request or session is kept beyond the `recheck` callback.
 */

export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform: proxies (and compression) must not buffer or alter the stream.
  "Cache-Control": "no-cache, no-store, no-transform",
  Connection: "keep-alive",
  // Nginx and similar proxies: don't buffer.
  "X-Accel-Buffering": "no",
};

export const SSE_DEFAULTS = { heartbeatMs: 25_000, recheckMs: 60_000, maxLifetimeMs: 270_000, retryMs: 5_000 };

export function createMonitoringStream(opts: {
  assessmentId: string;
  bus: MonitoringBus;
  /** The request's abort signal: the client went away. */
  signal?: AbortSignal;
  /** Is the viewer still allowed to watch this assessment? */
  recheck: () => Promise<boolean>;
  heartbeatMs?: number;
  recheckMs?: number;
  maxLifetimeMs?: number;
  retryMs?: number;
  now?: () => Date;
}): ReadableStream<Uint8Array> {
  const o = { ...SSE_DEFAULTS, ...opts };
  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const timers: ReturnType<typeof setInterval>[] = [];
      let unsubscribe: (() => void) | null = null;

      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };
      const message = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      function close() {
        if (closed) return;
        closed = true;
        for (const t of timers) clearInterval(t);
        timers.length = 0;
        unsubscribe?.();
        unsubscribe = null;
        opts.signal?.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }
      cleanup = close;

      write(`retry: ${o.retryMs}\n\n`);
      try {
        unsubscribe = o.bus.subscribe(o.assessmentId, (e: MonitoringEvent) => {
          if (e.assessmentId === o.assessmentId) message(e.type, e);
        });
      } catch {
        // Subscribing was refused (too many connections): end; the client falls back to polling.
        close();
        return;
      }
      message(STREAM_SNAPSHOT, { assessmentId: o.assessmentId, at: (o.now?.() ?? new Date()).toISOString() });

      timers.push(setInterval(() => write(`: ping\n\n`), o.heartbeatMs));
      timers.push(
        setInterval(() => {
          o.recheck().then(
            (ok) => {
              if (ok) return;
              message(STREAM_REVOKED, {});
              close();
            },
            () => {
              // Can't confirm access (e.g. the database is unreachable): end; the client reconnects or polls.
              close();
            },
          );
        }, o.recheckMs),
      );
      // A one-off timer, kept with the others so close() clears it.
      timers.push(setTimeout(close, o.maxLifetimeMs) as unknown as ReturnType<typeof setInterval>);

      if (opts.signal?.aborted) close();
      else opts.signal?.addEventListener("abort", close);
    },
    cancel() {
      cleanup?.();
    },
  });
}
