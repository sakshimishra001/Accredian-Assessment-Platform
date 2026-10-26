import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Lock, Users } from "lucide-react";
import { DetailList, EmptyState, MetricCard, PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { STATUS_LABEL } from "@/lib/assessments/lifecycle";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { proctoringSummary } from "@/lib/proctoring/summary";
import { formatDateTime, formatNumber } from "@/prototype/lib/format";
import { requireRole } from "@/server/auth/guards";
import { getProctorMonitoring } from "@/server/services/proctor-monitoring";
import { LiveUpdates } from "../../live-updates";
import { MonitoringStatusLine } from "../../evidence";
import { PresenceStatus } from "../../presence";
import { ago, remaining } from "../../format";

export const metadata: Metadata = { title: "Monitor assessment" };

/**
 * Live monitoring of one assessment (read-only; refreshes by polling). Only the running attempts of
 * this assessment, and only for an administrator or a proctor assigned to it — anything else is
 * "not found" (checked on the server for every request, whatever the URL).
 */
export default async function MonitorAssessmentPage({ params }: PageProps<"/proctor/assessments/[id]">) {
  const actor = await requireRole(Role.REVIEWER, Role.ADMIN);
  const { id } = await params;
  const m = await getProctorMonitoring(actor, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  const a = m.assessment;
  const locked = m.attempts.filter((t) => t.lockedAt).length;
  const withViolations = m.attempts.filter((t) => t.counted > 0).length;
  // Camera / face / screen state and evidence (phase 7), when the assessment monitors any of them.
  const showMonitoring = a.monitoring.camera || a.monitoring.screen || a.monitoring.evidence;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Assigned Assessments", href: "/proctor" }, { label: a.name }]}
        title={a.name}
        meta={<StatusBadge status={STATUS_LABEL[a.status]} />}
        description={`${formatDateTime(a.startAt.toISOString())} – ${formatDateTime(a.endAt.toISOString())} IST`}
        actions={<LiveUpdates assessmentId={a.id} asOf={m.serverTime} />}
      />
      {a.status === "PAUSED" ? <p className="mb-5 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">This assessment is paused by an administrator. Timers are frozen.</p> : null}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Active attempts" value={formatNumber(m.attempts.length)} hint={`of ${formatNumber(a.assignedLearners)} assigned learners`} />
        <MetricCard label="With violations" value={formatNumber(withViolations)} tone={withViolations ? "attention" : "default"} />
        <MetricCard label="Locked" value={formatNumber(locked)} tone={locked ? "attention" : "default"} />
        <MetricCard label="Violation limit" value={a.proctoring.proctoringEnabled ? formatNumber(a.proctoring.focusMaxViolations) : "—"} hint={a.proctoring.proctoringEnabled ? `then ${a.proctoring.focusViolationAction.toLowerCase()}` : "Proctoring off"} />
      </div>

      <Panel title="Learners taking the assessment now" description="Running attempts only. Violation counts are the server’s record." bodyClassName="p-0">
        {m.attempts.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={<Users />} title="No one is taking this assessment right now" description="Attempts appear here as learners start." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Learner</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead title="Whether the learner’s exam page is connected (not a violation)">Connection</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="text-right">Time left</TableHead>
                  <TableHead className="text-right" title="Left the exam (focus lost)">
                    Focus
                  </TableHead>
                  <TableHead className="text-right" title="Exited fullscreen">
                    Fullscreen
                  </TableHead>
                  <TableHead className="text-right" title="Clipboard copy / cut / paste">
                    Clipboard
                  </TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="pr-4">Last activity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {m.attempts.map((t) => (
                  <TableRow key={t.id} className={t.lockedAt ? "bg-red-50/40" : undefined}>
                    <TableCell className="pl-4">
                      <Link href={`/proctor/assessments/${a.id}/attempts/${t.id}`} className="font-medium hover:underline">
                        {t.learner.name}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{t.learner.email}</span>
                    </TableCell>
                    <TableCell>
                      {t.lockedAt ? (
                        <span className="inline-flex items-center gap-1 text-sm font-medium text-red-700">
                          <Lock className="size-3.5" aria-hidden /> Locked
                        </span>
                      ) : (
                        <StatusBadge status="In progress" />
                      )}
                    </TableCell>
                    <TableCell>
                      <PresenceStatus presence={t.presence} now={m.serverTime} />
                      {showMonitoring ? <MonitoringStatusLine className="mt-1 max-w-56" monitored={a.monitoring} status={t.presence.status} online={t.presence.online} evidenceCount={t.evidenceCount} /> : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(t.startedAt.toISOString())}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.status === "PAUSED" ? `${remaining(t.remainingSeconds)} (paused)` : remaining(t.remainingSeconds)}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.violations.focus}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.violations.fullscreen}</TableCell>
                    <TableCell className="text-right tabular-nums" title={`Copy ${t.violations.clipboardCopy} · Cut ${t.violations.clipboardCut} · Paste ${t.violations.clipboardPaste}`}>
                      {t.violations.clipboard}
                      {t.violations.clipboard ? (
                        <span className="block text-[11px] text-muted-foreground">
                          C {t.violations.clipboardCopy} · X {t.violations.clipboardCut} · P {t.violations.clipboardPaste}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className={t.counted ? "text-right font-semibold tabular-nums" : "text-right tabular-nums"}>
                      {t.counted}
                      {a.proctoring.proctoringEnabled ? <span className="font-normal text-muted-foreground"> / {a.proctoring.focusMaxViolations}</span> : null}
                    </TableCell>
                    <TableCell className="pr-4 whitespace-nowrap text-muted-foreground">{ago(t.lastActivityAt, m.serverTime)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      <Panel className="mt-6" title="Proctoring settings">
        <DetailList items={[["Proctoring", proctoringSummary(a.proctoring)]]} />
      </Panel>
    </>
  );
}
