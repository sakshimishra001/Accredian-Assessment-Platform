import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DetailList, MetricCard, PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { formatDateTime, formatNumber } from "@/prototype/lib/format";
import { requireRole } from "@/server/auth/guards";
import { getProctorAttempt } from "@/server/services/proctor-monitoring";
import { LiveUpdates } from "../../../../live-updates";
import { ago, remaining } from "../../../../format";
import { PresenceStatus } from "../../../../presence";
import { EvidenceThumb, evidencePageUrl, MonitoringStatusLine } from "../../../../evidence";
import { AttemptActions } from "./attempt-actions";
import { ProctorTimeline } from "./proctor-timeline";

export const metadata: Metadata = { title: "Learner timeline" };

const STATUS: Record<string, string> = { IN_PROGRESS: "In progress", SUBMITTED: "Submitted", AUTO_SUBMITTED: "Auto-submitted", TERMINATED: "Terminated" };
const iso = (d: Date) => d.toISOString();

/**
 * One learner's attempt (read-only): status, timing, lock state, violations by kind and the
 * proctoring timeline. The attempt must belong to this assessment, and the assessment must be one
 * the viewer may proctor — otherwise "not found".
 */
export default async function ProctorAttemptPage({ params }: PageProps<"/proctor/assessments/[id]/attempts/[attemptId]">) {
  const actor = await requireRole(Role.REVIEWER, Role.ADMIN);
  const { id, attemptId } = await params;
  const r = await getProctorAttempt(actor, id, attemptId).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  const t = r.attempt;
  const running = t.status === "IN_PROGRESS";
  const v = r.violations;
  const monitored = r.assessment.monitoring;
  const latest = (type: "CAMERA" | "SCREEN") => r.evidence.findLast((e) => e.type === type) ?? null;
  const showEvidence = monitored.camera || monitored.screen || monitored.evidence || r.evidence.length > 0;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Assigned Assessments", href: "/proctor" }, { label: r.assessment.name, href: `/proctor/assessments/${r.assessment.id}` }, { label: t.learner.name }]}
        title={t.learner.name}
        meta={t.lockedAt && running ? <StatusBadge status="Locked" /> : <StatusBadge status={STATUS[t.status] ?? t.status} />}
        description={`${t.learner.email} · attempt #${t.attemptNumber}`}
        actions={running ? <LiveUpdates assessmentId={r.assessment.id} attemptId={t.id} asOf={r.serverTime} /> : null}
      />

      {running ? (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
          <p className="text-sm text-muted-foreground">{t.lockedAt ? "This attempt is locked: the learner can no longer change or submit answers." : "Lock or terminate this attempt if needed. A reason is required and recorded."}</p>
          <AttemptActions assessmentId={r.assessment.id} attemptId={t.id} learnerName={t.learner.name} locked={!!t.lockedAt} />
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <MetricCard label="Focus" value={formatNumber(v.focus)} hint="Left the exam" />
        <MetricCard label="Fullscreen" value={formatNumber(v.fullscreen)} hint="Exited fullscreen" />
        <MetricCard label="Clipboard" value={formatNumber(v.clipboard)} hint={`Copy ${v.clipboardCopy} · Cut ${v.clipboardCut} · Paste ${v.clipboardPaste}`} />
        <MetricCard label="Other" value={formatNumber(v.other)} hint="Earlier counted camera / face" />
        <MetricCard label="Total" value={`${formatNumber(t.focusViolations)} / ${formatNumber(r.assessment.maxViolations)}`} hint={`At the limit: ${r.assessment.action.toLowerCase()}`} tone={t.focusViolations ? "attention" : "default"} />
      </div>

      <Panel title="Attempt">
        <DetailList
          items={[
            ["Status", STATUS[t.status] ?? t.status],
            [
              "Connection",
              running ? (
                <PresenceStatus key="presence" presence={r.presence} now={r.serverTime} detailed />
              ) : (
                <span key="presence" className="text-muted-foreground">
                  Attempt ended{r.presence.lastSeenAt ? ` · last seen ${formatDateTime(iso(r.presence.lastSeenAt))} IST` : ""}
                </span>
              ),
            ],
            ["Locked", t.lockedAt ? `Yes — since ${formatDateTime(iso(t.lockedAt))} IST` : "No"],
            ["Started", `${formatDateTime(iso(t.startedAt))} IST`],
            [running ? "Ends" : "Deadline", `${formatDateTime(iso(t.effectiveEndAt))} IST`],
            ...(running ? ([["Time remaining", remaining(t.remainingSeconds)]] as [string, string][]) : []),
            ...(t.submittedAt ? ([["Submitted", `${formatDateTime(iso(t.submittedAt))} IST`]] as [string, string][]) : []),
            ...(t.terminatedAt
              ? ([["Terminated", `${formatDateTime(iso(t.terminatedAt))} IST · ${t.terminatedBySystem ? "proctoring violation limit reached" : `by ${t.terminatedBy ? `${t.terminatedBy.name} (${t.terminatedBy.role})` : "staff"}${t.terminationReason ? ` — ${t.terminationReason}` : ""}`}`]] as [string, string][])
              : []),
            ["Last activity", `${formatDateTime(iso(t.lastActivityAt))} IST (${ago(t.lastActivityAt, r.serverTime)})`],
            ["Saved answers", formatNumber(t.savedAnswers)],
          ]}
        />
      </Panel>

      {showEvidence ? (
        <Panel
          className="mt-6"
          title="Proctoring evidence"
          description="Camera / screen state from the learner’s exam page and still snapshots taken at randomized times. Images open only for administrators and assigned proctors."
        >
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              {running ? (
                <MonitoringStatusLine monitored={monitored} status={r.presence.status} online={r.presence.online} className="text-sm" />
              ) : (
                <span className="text-muted-foreground">Attempt ended — no live camera or screen state.</span>
              )}
              <span className="text-muted-foreground">
                {formatNumber(r.evidence.length)} snapshot{r.evidence.length === 1 ? "" : "s"} stored
              </span>
              {r.evidence.length ? (
                <a href={evidencePageUrl(r.assessment.id, t.id, r.evidence[r.evidence.length - 1].id)} className="text-sm font-medium text-primary hover:underline">
                  Open evidence viewer
                </a>
              ) : null}
            </div>
            {monitored.evidence || r.evidence.length ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {monitored.camera || latest("CAMERA") ? <EvidenceThumb assessmentId={r.assessment.id} attemptId={t.id} item={latest("CAMERA")} label="Latest camera snapshot" /> : null}
                {monitored.screen || latest("SCREEN") ? <EvidenceThumb assessmentId={r.assessment.id} attemptId={t.id} item={latest("SCREEN")} label="Latest screen snapshot" /> : null}
              </div>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <Panel
        className="mt-6"
        title="Proctoring timeline"
        description="Proctoring events recorded by the server, manual lock / terminate actions by staff and evidence snapshots, oldest first (times are the server’s). Every violation counts towards one limit; camera / screen notices and snapshots never count."
        bodyClassName="p-0"
      >
        {r.events.length || r.manualActions.length || r.evidence.length ? (
          <ProctorTimeline events={r.events} actions={r.manualActions} evidence={r.evidence} evidenceHref={(id) => evidencePageUrl(r.assessment.id, t.id, id)} />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">No proctoring events or staff actions for this attempt.</p>
        )}
      </Panel>
    </>
  );
}
