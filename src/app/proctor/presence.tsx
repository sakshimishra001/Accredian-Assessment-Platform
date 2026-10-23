import { cn } from "cn";
import { formatDateTime } from "@/prototype/lib/format";
import { ago } from "./format";

/**
 * Whether the learner's exam page is connected (phase 6): a small dot and "Online" / "Offline",
 * with when it was last seen. Connection status only — not a violation, and nothing acts on it.
 */
export function PresenceStatus({ presence, now, detailed = false }: { presence: { online: boolean; lastSeenAt: Date | null }; now: Date; detailed?: boolean }) {
  const seen = presence.lastSeenAt;
  const title = seen ? `Last seen ${formatDateTime(seen.toISOString())} IST` : "Not seen by this server yet";
  return (
    <span className="inline-flex flex-col" title={title}>
      <span className="inline-flex items-center gap-1.5 text-sm">
        <span aria-hidden className={cn("size-2 rounded-full", presence.online ? "bg-emerald-500" : "bg-muted-foreground/40")} />
        {presence.online ? "Online" : "Offline"}
      </span>
      <span className="text-[11px] text-muted-foreground">
        {seen ? (detailed ? `Last seen ${formatDateTime(seen.toISOString())} IST (${ago(seen, now)})` : `seen ${ago(seen, now)}`) : "not seen yet"}
      </span>
    </span>
  );
}
