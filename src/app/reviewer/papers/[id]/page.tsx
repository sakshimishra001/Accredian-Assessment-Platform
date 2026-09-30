"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { CircleCheck, MessageSquareWarning } from "lucide-react";
import { approvalChecks } from "@/components/proto/import/approve-step";
import { EmptyState, PageHeader, Panel } from "@/components/proto/page";
import { PaperStats, PaperStructure } from "@/components/proto/paper-summary";
import { QuestionView } from "@/components/proto/question-view";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { sectionQuestions } from "@/prototype/lib/paper";
import { useLookups, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";

export default function ReviewerPaperPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const lookup = useLookups();
  const toast = useToast();
  const { updatePaper } = useProtoActions();
  const paper = lookup.paper(id);
  const [changesOpen, setChangesOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);

  if (!paper) {
    return <EmptyState className="mt-10" title="Question paper not found" action={<Link href="/reviewer" className={buttonVariants()}>Back to queue</Link>} />;
  }
  const checks = approvalChecks(paper);
  const ready = checks.items.every((i) => i.ok);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Review Queue", href: "/reviewer" }, { label: paper.name }]}
        title={paper.name}
        meta={<StatusBadge status={paper.status} />}
        description={`${lookup.course(paper.courseId)?.name} · ${paper.subject} · ${paper.version}`}
        actions={
          <>
            <Button variant="outline" onClick={() => setChangesOpen(true)}>
              <MessageSquareWarning /> Request changes
            </Button>
            <Button
              onClick={() => {
                if (!ready) {
                  toast.error("This paper can’t be approved yet", checks.items.filter((i) => !i.ok).map((i) => i.detail).join(" · "));
                  return;
                }
                updatePaper(paper.id, { status: "Approved" });
                toast.success("Question paper approved", "Administrators can now use it in assessments.");
                router.push("/reviewer");
              }}
            >
              <CircleCheck /> Approve
            </Button>
          </>
        }
      />
      <div className="grid gap-6">
        <Panel title="Checks">
          <ul className="grid gap-1.5 text-sm">
            {checks.items.map((i) => (
              <li key={i.label} className="flex items-center gap-2">
                <CircleCheck className={i.ok ? "size-4 text-emerald-600" : "size-4 text-muted-foreground"} />
                <span className={i.ok ? "" : "text-muted-foreground"}>{i.label}</span>
                <span className="text-xs text-muted-foreground">— {i.detail}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Structure">
          <PaperStats paper={paper} />
          <PaperStructure paper={paper} className="mt-4" />
        </Panel>
        {paper.sections.map((s) => (
          <Panel key={s.id} title={s.name} description={`${s.range} · ${s.marks} marks`}>
            <div className="grid gap-6">
              {sectionQuestions(paper, s.id).map((q) => (
                <QuestionView key={q.id} q={q} />
              ))}
            </div>
          </Panel>
        ))}
      </div>

      <Dialog open={changesOpen} onOpenChange={setChangesOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Request changes</DialogTitle>
            <DialogDescription>The administrator who imported this paper will see your note.</DialogDescription>
          </DialogHeader>
          <Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Q7: answer key should be option B; Section C marks look high." aria-label="Review note" />
          {noteError ? <p className="text-xs text-destructive">{noteError}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setChangesOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (note.trim().length < 5) {
                  setNoteError("Describe what needs to change.");
                  return;
                }
                updatePaper(paper.id, { status: "Needs Review" });
                setChangesOpen(false);
                toast.success("Changes requested", "The paper was sent back to the administrator (simulated notification).");
                router.push("/reviewer");
              }}
            >
              Send request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
