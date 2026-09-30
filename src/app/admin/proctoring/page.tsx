"use client";

import Link from "next/link";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button } from "@/components/ui/button";
import { useProto } from "@/prototype/store";
import { useToast } from "@/prototype/toast";

export default function ProctoringPage() {
  const toast = useToast();
  const { assessments } = useProto();
  const withProctoring = assessments.filter((a) => a.settings.proctoring && ["Scheduled", "Active"].includes(a.status));

  return (
    <>
      <PageHeader title="Proctoring" description="Proctoring has not been configured." />

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Panel>
          <div className="flex flex-col items-start gap-4 sm:flex-row">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted">
              <ShieldOff className="size-6 text-muted-foreground" aria-hidden />
            </span>
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">Third-party proctoring integration</h2>
                <StatusBadge status="Not configured" />
              </div>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                Connect a proctoring provider to monitor learners during assessments — identity checks, browser lockdown and session review. The platform
                exposes a provider interface; no provider is connected in this version.
              </p>
              <Button className="mt-4" onClick={() => toast.info("Coming in a future version.", "Proctoring provider configuration is not part of this prototype.")}>
                <ShieldCheck /> Configure Provider
              </Button>
            </div>
          </div>
        </Panel>

        <Panel title="Assessments requesting proctoring">
          {withProctoring.length === 0 ? (
            <p className="text-sm text-muted-foreground">No scheduled or active assessments have proctoring enabled.</p>
          ) : (
            <ul className="grid gap-2">
              {withProctoring.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                  <Link href={`/admin/assessments/${a.id}`} className="truncate hover:underline">
                    {a.name}
                  </Link>
                  <StatusBadge status={a.status} />
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">These run without monitoring until a provider is configured.</p>
        </Panel>
      </div>
    </>
  );
}
