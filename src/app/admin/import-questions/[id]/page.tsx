"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, Archive, ArchiveRestore, ClipboardList, Copy, FileSearch, Pencil } from "lucide-react";
import { cn } from "cn";
import { ConfirmDialog } from "@/components/proto/controls";
import { usePaperActions } from "@/components/proto/paper-actions";
import { DetailList, EmptyState, PageHeader, Panel } from "@/components/proto/page";
import { PaperStats, PaperStructure } from "@/components/proto/paper-summary";
import { QuestionView } from "@/components/proto/question-view";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/prototype/lib/format";
import { paperTotals, sectionQuestions } from "@/prototype/lib/paper";
import { useLookups, useProto } from "@/prototype/store";

export default function PaperDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const state = useProto();
  const lookup = useLookups();
  const { duplicate, archive, restore, createAssessment } = usePaperActions();
  const [showAnswers, setShowAnswers] = useState(true);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [section, setSection] = useState<string>("all");
  const paper = lookup.paper(id);

  if (!paper) {
    return (
      <EmptyState
        className="mt-10"
        title="Question paper not found"
        description="It may have been created in a previous session — prototype data resets on refresh."
        action={<Link href="/admin/import-questions" className={buttonVariants()}>Back to library</Link>}
      />
    );
  }

  const totals = paperTotals(paper);
  const usedBy = state.assessments.filter((a) => a.paperId === paper.id);
  const sections = section === "all" ? paper.sections : paper.sections.filter((s) => s.id === section);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Import Questions", href: "/admin/import-questions" }, { label: paper.name }]}
        title={paper.name}
        meta={<StatusBadge status={paper.status} />}
        description={`${lookup.course(paper.courseId)?.name} · ${paper.subject} · ${lookup.batch(paper.batchId)?.label} · ${paper.version}`}
        actions={
          <>
            <Button variant="outline" onClick={() => router.push(`/admin/import-questions/${duplicate(paper).id}`)}>
              <Copy /> Duplicate
            </Button>
            {paper.status === "Archived" ? (
              <Button variant="outline" onClick={() => restore(paper)}>
                <ArchiveRestore /> Restore
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setConfirmArchive(true)}>
                <Archive /> Archive
              </Button>
            )}
            {paper.status !== "Archived" && paper.status !== "Processing" ? (
              <Link href={`/admin/import-questions/new?paper=${paper.id}&step=1`} className={buttonVariants({ variant: "outline" })}>
                <Pencil /> Edit
              </Link>
            ) : null}
            {paper.status === "Needs Review" || paper.status === "Draft" ? (
              <Link href={`/admin/import-questions/new?paper=${paper.id}&step=2`} className={buttonVariants()}>
                <FileSearch /> Review & approve
              </Link>
            ) : null}
            {paper.status === "Approved" ? (
              <Button onClick={() => createAssessment(paper)}>
                <ClipboardList /> Create Assessment
              </Button>
            ) : null}
          </>
        }
      />

      {paper.status === "Processing" ? (
        <p className="mb-6 rounded-lg bg-accent px-4 py-3 text-sm text-accent-foreground">This paper is still being processed. Questions shown are a preliminary extraction.</p>
      ) : null}
      {totals.needsReview ? (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-4" /> {totals.needsReview} question{totals.needsReview === 1 ? "" : "s"} need review before this paper can be approved.
          </span>
          <Link href={`/admin/import-questions/new?paper=${paper.id}&step=2`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Review now
          </Link>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="grid min-w-0 content-start gap-6">
          <Panel title="Summary">
            <PaperStats paper={paper} />
            <PaperStructure paper={paper} className="mt-4" />
          </Panel>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Section">
              {[{ id: "all", name: "All sections" }, ...paper.sections].map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={section === s.id}
                  onClick={() => setSection(s.id)}
                  className={cn("rounded-md px-2.5 py-1 text-xs font-medium", section === s.id ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground ring-1 ring-border hover:bg-muted")}
                >
                  {s.name.split(" — ")[0]}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={showAnswers} onChange={(e) => setShowAnswers(e.target.checked)} className="size-4 accent-[var(--primary)]" />
              Show answer key
            </label>
          </div>

          {sections.map((s) => (
            <Panel key={s.id} title={s.name} description={`${s.range} · ${s.marks} marks`}>
              <div className="grid gap-6">
                {sectionQuestions(paper, s.id).map((q) => (
                  <QuestionView key={q.id} q={q} showAnswers={showAnswers} />
                ))}
                {sectionQuestions(paper, s.id).length === 0 ? <p className="text-sm text-muted-foreground">No questions in this section.</p> : null}
              </div>
            </Panel>
          ))}
        </div>

        <aside className="grid content-start gap-6">
          <Panel title="Details">
            <DetailList
              className="grid-cols-[6rem_1fr]"
              items={[
                ["Source", paper.source === "Manual" ? "Created manually" : `${paper.source} import`],
                ["File", paper.fileName ?? "—"],
                ["Imported", formatDateTime(paper.importedOn)],
                ["Version", paper.version],
                ["Duration", `${paper.durationMinutes} min (suggested)`],
                ["Description", paper.description || "—"],
              ]}
            />
          </Panel>
          <Panel title="Used in assessments">
            {usedBy.length === 0 ? (
              <p className="text-sm text-muted-foreground">Not used yet.</p>
            ) : (
              <ul className="grid gap-2">
                {usedBy.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0">
                      <Link href={`/admin/assessments/${a.id}`} className="block truncate hover:underline">
                        {a.name}
                      </Link>
                      <span className="text-xs text-muted-foreground">{formatDate(a.schedule.start)}</span>
                    </span>
                    <StatusBadge status={a.status} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title="Archive this question paper?"
        description="Archived papers can’t be selected for new assessments. You can restore it later."
        confirmLabel="Archive"
        destructive
        onConfirm={() => archive(paper)}
      />
    </>
  );
}
