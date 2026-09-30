"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { ConfirmDialog, Stepper } from "@/components/proto/controls";
import { ApproveStep, approvalChecks } from "@/components/proto/import/approve-step";
import { DetailsStep, validateDetails } from "@/components/proto/import/details-step";
import { ReviewStep } from "@/components/proto/import/review-step";
import { UploadStep } from "@/components/proto/import/upload-step";
import type { ImportMethodKey } from "@/components/proto/import-methods";
import { EmptyState, PageHeader } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { withSuspense } from "@/components/proto/suspense-page";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { paperTotals } from "@/prototype/lib/paper";
import { newId, useProto, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { QuestionPaper } from "@/prototype/types";

const STEPS = ["Import method", "Paper details", "Review & edit", "Approve"];

function bumpVersion(v: string) {
  const m = /^v?(\d+)\.(\d+)$/.exec(v);
  return m ? `v${m[1]}.${Number(m[2]) + 1}` : v;
}

function ImportWizard() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const state = useProto();
  const { savePaper } = useProtoActions();
  const existing = params.get("paper") ? state.papers.find((p) => p.id === params.get("paper")) : undefined;
  const wasApproved = existing?.status === "Approved";

  const [paper, setPaper] = useState<QuestionPaper | null>(existing ?? null);
  const [method, setMethod] = useState<ImportMethodKey | null>((["excel", "word", "pdf"] as const).find((m) => m === params.get("method")) ?? null);
  const [step, setStep] = useState(existing ? Math.min(3, Math.max(1, Number(params.get("step")) || 1)) : 0);
  const [maxReached, setMaxReached] = useState(existing ? 3 : 0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reviewFilter, setReviewFilter] = useState<"all" | "review">("all");
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [approved, setApproved] = useState<QuestionPaper | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  // Keep the library in sync so the paper appears there as soon as it is imported.
  const update = (p: QuestionPaper) => {
    const next = wasApproved && p.status === "Approved" ? { ...p, status: "Draft" as const } : p;
    setPaper(next);
    savePaper(next);
  };

  function goTo(next: number, opts?: { filter?: "all" | "review" }) {
    if (!paper && next > 0) {
      toast.error("Import a question paper first");
      return;
    }
    if (paper && next > 1 && step <= 1) {
      const e = validateDetails(paper);
      if (Object.keys(e).length) {
        setErrors(e);
        setStep(1);
        toast.error("Please complete the paper details and structure");
        return;
      }
    }
    setErrors({});
    if (opts?.filter) setReviewFilter(opts.filter);
    setStep(next);
    setMaxReached((m) => Math.max(m, next));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function createManual() {
    const id = newId("p");
    const sectionId = `${id}-sA`;
    const p: QuestionPaper = {
      id,
      name: "",
      courseId: "",
      subject: "",
      batchId: "",
      description: "",
      version: "v1.0",
      status: "Draft",
      source: "Manual",
      importedOn: new Date().toISOString(),
      durationMinutes: 60,
      sections: [{ id: sectionId, name: "Section A", range: "Q1", rule: "COMPULSORY", marks: 10 }],
      questions: [
        {
          id: `${id}-q1`,
          number: "1",
          type: "MCQ_SINGLE",
          text: "",
          options: [0, 1, 2, 3].map((i) => ({ id: `${id}-o${i}`, text: "", correct: false })),
          marks: 1,
          sectionId,
          compulsory: true,
          needsReview: true,
          reviewNote: "New question — complete the details.",
          children: [],
        },
      ],
    };
    update(p);
    setStep(1);
    setMaxReached(1);
  }

  function approve() {
    if (!paper) return;
    const final: QuestionPaper = { ...paper, status: "Approved", version: wasApproved ? bumpVersion(paper.version) : paper.version };
    setPaper(final);
    savePaper(final);
    setApproved(final);
  }

  const checks = paper ? approvalChecks(paper) : null;
  const ready = checks?.items.every((i) => i.ok) ?? false;

  if (params.get("paper") && !existing) {
    return (
      <EmptyState
        className="mt-10"
        title="Question paper not found"
        description="Prototype data resets when the page is refreshed."
        action={<Button onClick={() => router.push("/admin/import-questions")}>Back to Import Questions</Button>}
      />
    );
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Import Questions", href: "/admin/import-questions" }, { label: existing ? "Edit question paper" : "Import question paper" }]}
        title={existing ? existing.name : "Import Question Paper"}
        description={paper && step > 0 ? `${paper.fileName ?? "Created manually"} · ${paperTotals(paper).questions} questions` : "Upload a paper, configure its structure, review the questions and approve it for assessments."}
        meta={paper ? <StatusBadge status={paper.status} /> : null}
      />

      {wasApproved ? (
        <p className="mb-4 rounded-lg bg-accent px-4 py-2.5 text-sm text-accent-foreground">
          This paper is approved. Edits move it back to draft and approving again creates {bumpVersion(existing!.version)}. Assessments already scheduled keep {existing!.version}.
        </p>
      ) : null}

      <div className="mb-6 rounded-lg border bg-card px-4 py-3">
        <Stepper steps={STEPS} current={step} maxReached={paper ? maxReached : 0} onStepClick={(i) => goTo(i)} />
      </div>

      {step === 0 ? (
        <UploadStep
          method={method}
          onMethod={setMethod}
          paper={paper}
          onImported={(p) => {
            update(p);
            toast.success("Import complete", `${paperTotals(p).questions} questions detected in ${p.fileName}.`);
          }}
          onContinue={() => goTo(1)}
          onReview={() => {
            setMaxReached(2);
            setReviewFilter("review");
            setStep(2);
          }}
          onManual={createManual}
        />
      ) : null}

      {step === 1 && paper ? <DetailsStep paper={paper} onChange={update} errors={errors} /> : null}
      {step === 2 && paper ? <ReviewStep key={reviewFilter} paper={paper} onChange={update} initialFilter={reviewFilter} /> : null}
      {step === 3 && paper ? <ApproveStep paper={paper} onReviewIssues={() => goTo(2, { filter: "review" })} onEditDetails={() => goTo(1)} /> : null}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => (paper && step > 0 ? setConfirmLeave(true) : router.push("/admin/import-questions"))}>
            {paper ? "Save & exit" : "Cancel"}
          </Button>
          {step > 0 ? (
            <Button variant="outline" onClick={() => goTo(step - 1)}>
              Back
            </Button>
          ) : null}
        </div>
        {step > 0 && step < 3 ? <Button onClick={() => goTo(step + 1)}>Next</Button> : null}
        {step === 3 ? (
          <Button disabled={!ready} onClick={() => setConfirmApprove(true)} title={ready ? undefined : "Resolve the checklist first"}>
            <CircleCheck /> Approve Question Paper
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmApprove}
        onOpenChange={setConfirmApprove}
        title="Approve this question paper?"
        description="Approved papers can be selected when creating assessments. Further edits will create a new version."
        confirmLabel="Approve"
        onConfirm={approve}
      />

      <ConfirmDialog
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title="Save and exit?"
        description="Your progress is kept in the library (for this session). You can continue editing later."
        confirmLabel="Save & exit"
        cancelLabel="Keep editing"
        onConfirm={() => {
          toast.success("Question paper saved", paper?.status === "Approved" ? undefined : `Saved as ${paper?.status}.`);
          router.push("/admin/import-questions");
        }}
      />

      <Dialog open={approved !== null} onOpenChange={(o) => !o && router.push(`/admin/import-questions/${approved?.id}`)}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-emerald-50">
              <CircleCheck className="size-6 text-emerald-600" />
            </div>
            <DialogTitle>Question Paper Approved</DialogTitle>
            <DialogDescription>
              {approved?.name} is ready to use. Status: <span className="font-medium text-foreground">Approved</span> · {approved?.version}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => router.push(`/admin/import-questions/${approved?.id}`)}>
              View paper
            </Button>
            <Button onClick={() => router.push(`/admin/assessments/new?paper=${approved?.id}`)}>Create Assessment</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default withSuspense(ImportWizard);
