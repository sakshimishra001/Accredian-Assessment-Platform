import { cn } from "cn";
import { ACTION_LABEL, eventDetails, SEVERITY_LABEL, type ProctoringEventRow } from "@/components/proctoring/proctoring-event-table";
import { PROCTORING_EVENT_LABEL } from "@/lib/proctoring/config";
import { formatDateTime } from "@/prototype/lib/format";
import { EVIDENCE_TYPE_LABEL } from "@/lib/proctoring/evidence";
import type { ManualAction } from "@/server/services/proctor-monitoring";
import type { EvidenceItem } from "@/server/services/proctoring-evidence";

/*
 * One attempt's timeline for the proctor: the server's proctoring events and the manual lock /
 * terminate actions by staff (from the audit log), in time order. Each row says which it is. The
 * violation limit's own lock / termination are proctoring events (their action column); manual ones
 * name who did it and why.
 */

type Row = { at: Date; key: string } & ({ kind: "event"; event: ProctoringEventRow } | { kind: "manual"; action: ManualAction } | { kind: "evidence"; evidence: EvidenceItem });

export function timelineRows(events: readonly ProctoringEventRow[], actions: readonly ManualAction[], evidence: readonly EvidenceItem[] = []): Row[] {
  const rows: Row[] = [
    ...events.map((e): Row => ({ kind: "event", at: e.timestamp, key: `e-${e.id}`, event: e })),
    ...actions.map((a): Row => ({ kind: "manual", at: a.at, key: `m-${a.id}`, action: a })),
    // Snapshots (phase 7): light rows, never violations.
    ...evidence.map((x): Row => ({ kind: "evidence", at: x.capturedAt, key: `x-${x.id}`, evidence: x })),
  ];
  // Oldest first; stable, so events recorded at the same instant keep their order.
  return rows.map((r, i) => ({ r, i })).sort((x, y) => +x.r.at - +y.r.at || x.i - y.i).map(({ r }) => r);
}

const TYPE: Record<"event" | "lock" | "terminate" | "evidence", { label: string; className: string }> = {
  event: { label: "Proctoring event", className: "bg-muted text-muted-foreground" },
  evidence: { label: "Evidence", className: "text-muted-foreground ring-1 ring-border ring-inset" },
  lock: { label: "Manual lock", className: "bg-amber-50 text-amber-800 ring-1 ring-amber-200 ring-inset" },
  terminate: { label: "Manual termination", className: "bg-red-50 text-red-700 ring-1 ring-red-200 ring-inset" },
};

/** "Attempt locked by Pat (Proctor)". */
export function manualActionText(a: ManualAction) {
  const who = a.actor ? `${a.actor.name} (${a.actor.role})` : "staff";
  return `Attempt ${a.kind === "lock" ? "locked" : "terminated"} by ${who}`;
}

export function ProctorTimeline({
  events,
  actions,
  evidence = [],
  evidenceHref,
}: {
  events: readonly ProctoringEventRow[];
  actions: readonly ManualAction[];
  evidence?: readonly EvidenceItem[];
  /** The viewer page of a snapshot. */
  evidenceHref?: (evidenceId: string) => string;
}) {
  const rows = timelineRows(events, actions, evidence);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-2 pr-3 pl-4 font-medium">Time (IST)</th>
            <th className="py-2 pr-3 font-medium">Type</th>
            <th className="py-2 pr-3 font-medium">What happened</th>
            <th className="py-2 pr-3 text-right font-medium">Violation</th>
            <th className="py-2 pr-4 font-medium">Action / reason</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => {
            const kind = r.kind === "manual" ? r.action.kind : r.kind;
            const type = TYPE[kind];
            if (r.kind === "evidence") {
              const label = `${EVIDENCE_TYPE_LABEL[r.evidence.type]} snapshot captured`;
              return (
                <tr key={r.key} data-timeline-kind="evidence" className="text-xs text-muted-foreground">
                  <td className="py-1.5 pr-3 pl-4 align-top whitespace-nowrap">{formatDateTime(r.at.toISOString())}</td>
                  <td className="py-1.5 pr-3 align-top">
                    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap", type.className)}>{type.label}</span>
                  </td>
                  <td className="py-1.5 pr-3 align-top" colSpan={3}>
                    {evidenceHref ? (
                      <a href={evidenceHref(r.evidence.id)} className="hover:text-foreground hover:underline">
                        {label}
                      </a>
                    ) : (
                      label
                    )}
                  </td>
                </tr>
              );
            }
            return (
              <tr key={r.key} data-timeline-kind={kind}>
                <td className="py-2 pr-3 pl-4 align-top whitespace-nowrap text-muted-foreground">{formatDateTime(r.at.toISOString())}</td>
                <td className="py-2 pr-3 align-top">
                  <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", type.className)}>{type.label}</span>
                </td>
                {r.kind === "event" ? (
                  <>
                    <td className="py-2 pr-3 align-top">
                      {PROCTORING_EVENT_LABEL[r.event.eventType]}
                      <span className="block text-xs text-muted-foreground">Severity: {SEVERITY_LABEL[r.event.severity]}</span>
                    </td>
                    <td className="py-2 pr-3 text-right align-top tabular-nums">{r.event.violationNumber ?? "—"}</td>
                    <td className="py-2 pr-4 align-top">
                      {r.event.actionTaken ? ACTION_LABEL[r.event.actionTaken] : "—"}
                      {eventDetails(r.event) ? <span className="block text-xs text-muted-foreground">{eventDetails(r.event)}</span> : null}
                    </td>
                  </>
                ) : (
                  <>
                    <td className="py-2 pr-3 align-top font-medium">{manualActionText(r.action)}</td>
                    <td className="py-2 pr-3 text-right align-top">—</td>
                    <td className="py-2 pr-4 align-top">{r.action.reason ? <span>Reason: “{r.action.reason}”</span> : <span className="text-muted-foreground">No reason recorded</span>}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
