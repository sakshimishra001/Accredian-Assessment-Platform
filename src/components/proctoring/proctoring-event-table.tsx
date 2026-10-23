import type { ProctoringAction, ProctoringEventType, ProctoringSeverity } from "@/generated/prisma/enums";
import { PROCTORING_EVENT_LABEL } from "@/lib/proctoring/config";
import { formatDateTime } from "@/prototype/lib/format";

/*
 * An attempt's proctoring events, oldest first — the server's record (times are the server's).
 * Shared by the admin attempt result and the proctor dashboard. Details are the event's own small
 * metadata (never images, video or clipboard contents — none are ever recorded).
 */

export interface ProctoringEventRow {
  id: string;
  timestamp: Date;
  eventType: ProctoringEventType;
  severity: ProctoringSeverity;
  violationNumber: number | null;
  actionTaken: ProctoringAction | null;
  durationMs?: number | null;
  metadata?: unknown;
}

export const SEVERITY_LABEL: Record<ProctoringSeverity, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };
export const ACTION_LABEL: Record<ProctoringAction, string> = { WARNING: "Warning", LOCK: "Locked", TERMINATE: "Terminated" };
const SEVERITY = SEVERITY_LABEL;
const ACTION = ACTION_LABEL;

/** "12s", "3m 4s" — how long an incident lasted, as the browser reported it. */
function duration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The event's details as short "key: value" text (only plain values are ever stored). */
export function eventDetails(e: ProctoringEventRow) {
  const parts: string[] = [];
  if (e.durationMs) parts.push(`lasted ${duration(e.durationMs)}`);
  if (e.metadata && typeof e.metadata === "object" && !Array.isArray(e.metadata)) {
    for (const [k, v] of Object.entries(e.metadata as Record<string, unknown>)) {
      if (["string", "number", "boolean"].includes(typeof v)) parts.push(`${k}: ${String(v)}`);
    }
  }
  return parts.join(" · ");
}

export function ProctoringEventTable({ events, showDetails = false }: { events: readonly ProctoringEventRow[]; showDetails?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-2 pr-3 pl-4 font-medium">Time (IST)</th>
            <th className="py-2 pr-3 font-medium">Event</th>
            <th className="py-2 pr-3 font-medium">Severity</th>
            <th className="py-2 pr-3 text-right font-medium">Violation</th>
            <th className={showDetails ? "py-2 pr-3 font-medium" : "py-2 pr-4 font-medium"}>Action</th>
            {showDetails ? <th className="py-2 pr-4 font-medium">Details</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y">
          {events.map((e) => (
            <tr key={e.id}>
              <td className="py-2 pr-3 pl-4 whitespace-nowrap text-muted-foreground">{formatDateTime(e.timestamp.toISOString())}</td>
              <td className="py-2 pr-3">{PROCTORING_EVENT_LABEL[e.eventType]}</td>
              <td className="py-2 pr-3">{SEVERITY[e.severity]}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{e.violationNumber ?? "—"}</td>
              <td className={showDetails ? "py-2 pr-3" : "py-2 pr-4"}>{e.actionTaken ? ACTION[e.actionTaken] : "—"}</td>
              {showDetails ? <td className="py-2 pr-4 text-muted-foreground">{eventDetails(e) || "—"}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
