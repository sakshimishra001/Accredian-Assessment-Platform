import type { Metadata } from "next";
import Link from "next/link";
import { ShieldOff } from "lucide-react";
import { PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { STATUS_LABEL } from "@/lib/assessments/lifecycle";
import { Role } from "@/lib/auth/rbac";
import { requireRole } from "@/server/auth/guards";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Proctoring" };

/**
 * Proctoring status. No proctoring provider is integrated in this release, so the page only reports
 * that, and lists (from PostgreSQL) the upcoming or live assessments that asked for proctoring.
 */
export default async function ProctoringPage() {
  await requireRole(Role.ADMIN);
  const requesting = await db.assessment.findMany({
    where: { proctoringEnabled: true, status: { in: ["SCHEDULED", "ACTIVE", "PAUSED"] } },
    orderBy: { startAt: "asc" },
    select: { id: true, name: true, status: true },
  });

  return (
    <>
      <PageHeader title="Proctoring" description="No proctoring provider is connected." />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Panel>
          <div className="flex flex-col items-start gap-4 sm:flex-row">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted">
              <ShieldOff className="size-6 text-muted-foreground" aria-hidden />
            </span>
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">Third-party proctoring</h2>
                <StatusBadge status="Not configured" />
              </div>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                This release doesn’t include a proctoring integration. Assessments run without identity checks, browser lockdown or session recording,
                whatever their proctoring setting.
              </p>
            </div>
          </div>
        </Panel>

        <Panel title="Assessments requesting proctoring">
          {requesting.length === 0 ? (
            <p className="text-sm text-muted-foreground">No scheduled or active assessments have proctoring enabled.</p>
          ) : (
            <ul className="grid gap-2">
              {requesting.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                  <Link href={`/admin/assessments/${a.id}`} className="truncate hover:underline">
                    {a.name}
                  </Link>
                  <StatusBadge status={STATUS_LABEL[a.status]} />
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">These run without monitoring.</p>
        </Panel>
      </div>
    </>
  );
}
