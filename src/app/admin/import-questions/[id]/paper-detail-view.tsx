"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { AlertTriangle, CircleCheck, CopyPlus, Pencil } from "lucide-react";
import { PaperQuestions } from "@/components/papers/paper-questions";
import { DetailList, PageHeader, Panel } from "@/components/proto/page";
import { PaperStats, PaperStructure } from "@/components/proto/paper-summary";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { paperUsageLabel } from "@/lib/papers/rules";
import { toViewPaper } from "@/lib/papers/view-adapter";
import { formatDateTime } from "@/prototype/lib/format";
import { useToast } from "@/prototype/toast";
import { createRevisionAction } from "@/server/actions/question-papers";
import type { QuestionPaperDetail } from "@/server/services/question-papers";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function PaperDetailView({ paper }: { paper: QuestionPaperDetail }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const view = toViewPaper(paper);

  function newVersion() {
    startTransition(async () => {
      const result = await createRevisionAction(paper.id);
      if (!result.ok) return toast.error("Couldn’t create a new version", result.error);
      toast.success(`Version ${result.data!.version} created`, "Edit it, then select it in an assessment.");
      router.push(`/admin/import-questions/${result.data!.id}/edit`);
    });
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Import Questions", href: "/admin/import-questions" }, { label: paper.name }]}
        title={paper.name}
        meta={<StatusBadge status={paperUsageLabel({ inUse: paper.inUse, ready: paper.issues.length === 0 })} />}
        description={[paper.course.name, paper.subject, `v${paper.version}`].filter(Boolean).join(" · ")}
        actions={
          <>
            {!paper.inUse ? (
              <Link href={`/admin/import-questions/${paper.id}/edit`} className={buttonVariants()}>
                <Pencil /> Edit
              </Link>
            ) : null}
            {paper.inUse ? (
              <Button variant="outline" onClick={newVersion} disabled={pending}>
                <CopyPlus /> {pending ? "Creating…" : "New version"}
              </Button>
            ) : null}
          </>
        }
      />

      {paper.inUse ? (
        <p className="mb-6 flex items-center gap-2 rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
          <CircleCheck className="size-4" /> Used by {paper.assessmentCount} assessment{paper.assessmentCount === 1 ? "" : "s"}, so it can’t be changed. Create a new version to make changes.
        </p>
      ) : paper.issues.length ? (
        <p className="mb-6 flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
          <AlertTriangle className="size-4" /> Saved, but not usable in an assessment until these are fixed: {paper.issues.join(" · ")}
        </p>
      ) : (
        <p className="mb-6 flex items-center gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-200 ring-inset">
          <CircleCheck className="size-4" /> Ready — this paper can be selected when creating an assessment.
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="grid min-w-0 content-start gap-6">
          <Panel title="Summary">
            <PaperStats paper={view} />
            <PaperStructure paper={view} className="mt-4" />
          </Panel>
          <PaperQuestions paper={view} />
        </div>

        <aside className="grid content-start gap-6">
          <Panel title="Details">
            <DetailList
              className="grid-cols-[6.5rem_1fr]"
              items={[
                ["Course", `${paper.course.name} (${paper.course.code})`],
                ["Source", paper.sourceFileName ? `Imported from ${paper.sourceFileName}` : "Created manually"],
                ["Created", `${formatDateTime(iso(paper.createdAt))} by ${paper.createdBy.name}`],
                ["Version", paper.basedOn ? `v${paper.version} (revision of v${paper.basedOn.version})` : `v${paper.version}`],
                ["Duration", paper.durationMinutes ? `${paper.durationMinutes} min (suggested)` : "—"],
                ["Updated", formatDateTime(iso(paper.updatedAt))],
                ["Assessments", paper.inUse ? `Used by ${paper.assessmentCount}` : "Not used yet"],
                ["Description", paper.description || "—"],
              ]}
            />
          </Panel>
          {paper.instructions ? (
            <Panel title="Instructions for learners">
              <p className="text-sm whitespace-pre-line">{paper.instructions}</p>
            </Panel>
          ) : null}
        </aside>
      </div>
    </>
  );
}
