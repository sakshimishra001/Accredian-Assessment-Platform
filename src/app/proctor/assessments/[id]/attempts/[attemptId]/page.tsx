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
        <MetricCard label="Other" value={formatNumber(v.other)} hint="Camera / face" />
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

      <Panel
        className="mt-6"
        title="Proctoring timeline"
        description="Proctoring events recorded by the server and manual lock / terminate actions by staff, oldest first (times are the server’s). Every violation counts towards one limit."
        bodyClassName="p-0"
      >
        {r.events.length || r.manualActions.length ? (
          <ProctorTimeline events={r.events} actions={r.manualActions} />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">No proctoring events or staff actions for this attempt.</p>
        )}
      </Panel>
    </>
  );
}
