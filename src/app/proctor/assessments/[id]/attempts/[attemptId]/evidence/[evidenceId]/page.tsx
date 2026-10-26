import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PageHeader, Panel } from "@/components/proto/page";
import { buttonVariants } from "@/components/ui/button";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { EVIDENCE_TYPE_LABEL } from "@/lib/proctoring/evidence";
import { formatDateTime } from "@/prototype/lib/format";
import { requireRole } from "@/server/auth/guards";
import { getProctorAttemptContext } from "@/server/services/proctor-monitoring";
import { getEvidence } from "@/server/services/proctoring-evidence";
import { evidenceImageUrl, evidencePageUrl } from "../../../../../../evidence";

export const metadata: Metadata = { title: "Proctoring evidence" };

/**
 * One proctoring evidence snapshot (phase 7): the image, when it was taken, what it shows and the
 * attempt it belongs to, with the previous / next snapshot of the same attempt. Only for an
 * administrator or a proctor assigned to the assessment; evidence of another attempt or assessment
 * (whatever the URL says) is "not found". The image loads from the authorized evidence route.
 */
export default async function EvidenceViewerPage({ params }: PageProps<"/proctor/assessments/[id]/attempts/[attemptId]/evidence/[evidenceId]">) {
  const actor = await requireRole(Role.REVIEWER, Role.ADMIN);
  const { id, attemptId, evidenceId } = await params;
  const [ctx, ev] = await Promise.all([getProctorAttemptContext(actor, id, attemptId), getEvidence(actor, id, attemptId, evidenceId)]).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  const e = ev.evidence;
  const label = `${EVIDENCE_TYPE_LABEL[e.type]} snapshot`;
  const at = `${formatDateTime(e.capturedAt.toISOString())} IST`;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Assigned Assessments", href: "/proctor" },
          { label: ctx.assessment.name, href: `/proctor/assessments/${ctx.assessment.id}` },
          { label: ctx.learner.name, href: `/proctor/assessments/${ctx.assessment.id}/attempts/${ctx.attemptId}` },
          { label: "Evidence" },
        ]}
        title={label}
        description={`${ctx.learner.name} · attempt #${ctx.attemptNumber} · ${at}`}
        actions={
          <div className="flex items-center gap-2">
            {ev.previousId ? (
              <Link href={evidencePageUrl(id, attemptId, ev.previousId)} className={buttonVariants({ variant: "outline", size: "sm" })} aria-label="Previous snapshot">
                <ChevronLeft /> Previous
              </Link>
            ) : null}
            <span className="text-xs text-muted-foreground tabular-nums">
              {ev.position} of {ev.total}
            </span>
            {ev.nextId ? (
              <Link href={evidencePageUrl(id, attemptId, ev.nextId)} className={buttonVariants({ variant: "outline", size: "sm" })} aria-label="Next snapshot">
                Next <ChevronRight />
              </Link>
            ) : null}
          </div>
        }
      />
      <Panel title={label} description={`Taken ${at} (the server’s time). Proctoring evidence — viewable by administrators and assigned proctors only.`}>
        <div className="overflow-hidden rounded-md border bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element -- authorized, uncached evidence route */}
          <img src={evidenceImageUrl(id, attemptId, e.id)} alt={`${label}, ${at}`} referrerPolicy="no-referrer" className="mx-auto max-h-[70vh] w-full object-contain" />
        </div>
      </Panel>
    </>
  );
}
