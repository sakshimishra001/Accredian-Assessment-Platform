import Link from "next/link";
import { Camera, Monitor, ScanFace } from "lucide-react";
import { cn } from "cn";
import { EVIDENCE_TYPE_LABEL, type EvidenceType } from "@/lib/proctoring/evidence";
import { CAMERA_STATE_LABEL, FACE_STATE_LABEL, SCREEN_STATE_LABEL, type MonitoringStatus } from "@/lib/proctoring/monitoring-status";
import { formatDateTime } from "@/prototype/lib/format";

/*
 * Proctoring evidence on the proctor pages (phase 7): the learner's camera / face / screen state
 * (live status from the exam page — never a verdict or a violation) and snapshot images. Images are
 * only ever loaded from the authorized evidence route, which checks the viewer on every request.
 */

/** What the assessment monitors (from the server). */
export interface Monitored {
  camera: boolean;
  face: boolean;
  screen: boolean;
  evidence: boolean;
}

/** The authorized image route of one snapshot. */
export const evidenceImageUrl = (assessmentId: string, attemptId: string, evidenceId: string) =>
  `/api/proctor/assessments/${encodeURIComponent(assessmentId)}/attempts/${encodeURIComponent(attemptId)}/evidence/${encodeURIComponent(evidenceId)}`;

/** The viewer page of one snapshot. */
export const evidencePageUrl = (assessmentId: string, attemptId: string, evidenceId: string) => `/proctor/assessments/${assessmentId}/attempts/${attemptId}/evidence/${evidenceId}`;

type Tone = "ok" | "warn" | "off";
const DOT: Record<Tone, string> = { ok: "bg-emerald-500", warn: "bg-amber-500", off: "bg-muted-foreground/40" };

function Item({ icon, label, value, tone, title }: { icon: React.ReactNode; label: string; value: string; tone: Tone; title: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" title={title}>
      <span className="text-muted-foreground" aria-hidden>
        {icon}
      </span>
      <span className="sr-only">{label}:</span>
      <span aria-hidden className={cn("size-1.5 rounded-full", DOT[tone])} />
      <span className={tone === "warn" ? "text-amber-800" : undefined}>{value}</span>
    </span>
  );
}

/**
 * Compact camera / face / screen state and evidence count, for the monitoring table: e.g.
 * "Camera ● On · Face ● 1 face · Screen ● Sharing · 4 snapshots". Shown as unknown while the learner
 * is offline (the last state reported may be out of date).
 */
export function MonitoringStatusLine({ monitored, status, online, evidenceCount, className }: { monitored: Monitored; status: MonitoringStatus; online: boolean; evidenceCount?: number; className?: string }) {
  const unknown = "—";
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs", className)}>
      {monitored.camera ? (
        <Item
          icon={<Camera className="size-3.5" />}
          label="Camera"
          value={online && status.camera ? CAMERA_STATE_LABEL[status.camera] : unknown}
          tone={!online || !status.camera ? "off" : status.camera === "on" ? "ok" : "warn"}
          title="Camera (as reported by the learner’s exam page)"
        />
      ) : null}
      {monitored.face ? (
        <Item
          icon={<ScanFace className="size-3.5" />}
          label="Face"
          value={online && status.face ? FACE_STATE_LABEL[status.face] : unknown}
          tone={!online || !status.face ? "off" : status.face === "one" ? "ok" : "warn"}
          title="Face detection in the learner’s browser (status only, not a violation)"
        />
      ) : null}
      {monitored.screen ? (
        <Item
          icon={<Monitor className="size-3.5" />}
          label="Screen"
          value={online && status.screen ? SCREEN_STATE_LABEL[status.screen] : unknown}
          tone={!online || !status.screen ? "off" : status.screen === "sharing" ? "ok" : "warn"}
          title="Screen sharing (as reported by the learner’s exam page)"
        />
      ) : null}
      {monitored.evidence && evidenceCount !== undefined ? (
        <span className="whitespace-nowrap text-muted-foreground" title="Proctoring evidence snapshots stored for this attempt">
          {evidenceCount} snapshot{evidenceCount === 1 ? "" : "s"}
        </span>
      ) : null}
    </span>
  );
}

/** A snapshot thumbnail linking to the viewer. */
export function EvidenceThumb({
  assessmentId,
  attemptId,
  item,
  label,
}: {
  assessmentId: string;
  attemptId: string;
  item: { id: string; type: EvidenceType; capturedAt: Date } | null;
  label: string;
}) {
  return (
    <figure className="grid gap-1.5">
      <figcaption className="text-xs font-medium text-muted-foreground">{label}</figcaption>
      {item ? (
        <Link href={evidencePageUrl(assessmentId, attemptId, item.id)} className="group block overflow-hidden rounded-md border bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element -- authorized, uncached evidence route */}
          <img
            src={evidenceImageUrl(assessmentId, attemptId, item.id)}
            alt={`${EVIDENCE_TYPE_LABEL[item.type]} snapshot, ${formatDateTime(item.capturedAt.toISOString())} IST`}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="aspect-video w-full object-contain transition-opacity group-hover:opacity-90"
          />
        </Link>
      ) : (
        <div className="flex aspect-video items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">No snapshot yet</div>
      )}
      {item ? <span className="text-xs text-muted-foreground">{formatDateTime(item.capturedAt.toISOString())} IST</span> : null}
    </figure>
  );
}
