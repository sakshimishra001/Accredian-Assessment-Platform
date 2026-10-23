"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { formatDateTime } from "@/prototype/lib/format";

/**
 * Polling (proctor dashboard, phase 2): re-renders the page from the server every `everyMs` while
 * the tab is visible, and right away when it becomes visible again. Every refresh re-runs the
 * server-side authorization and reads fresh data; nothing is cached in the browser.
 */
export function AutoRefresh({ asOf, everyMs = 20_000 }: { asOf: Date; everyMs?: number }) {
  const router = useRouter();
  const asOfMs = asOf.getTime();
  const current = useRef(asOfMs);
  useEffect(() => {
    current.current = asOfMs;
  }, [asOfMs]);
  // Refreshing while the page still shows the render the refresh started from; a new render (a new `asOf`) ends it.
  const [refreshingFrom, setRefreshingFrom] = useState<number | null>(null);
  const refreshing = refreshingFrom === asOfMs;
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      setRefreshingFrom(current.current);
      router.refresh();
    };
    const t = setInterval(refresh, everyMs);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router, everyMs]);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
      <RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
      Updated {formatDateTime(asOf.toISOString())} IST · refreshes every {Math.round(everyMs / 1000)}s
    </span>
  );
}
