/** Display helpers for the proctor pages (server time in, plain text out). */

/** Time remaining, e.g. "42m", "1h 05m", "45s". */
export function remaining(seconds: number) {
  if (seconds <= 0) return "0m";
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** How long ago, relative to the server's time, e.g. "just now", "3 min ago", "2 h ago". */
export function ago(at: Date, now: Date) {
  const s = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
  if (s < 30) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}
