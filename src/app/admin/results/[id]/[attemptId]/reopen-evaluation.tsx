"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Undo2 } from "lucide-react";
import { Field } from "@/components/proto/controls";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/prototype/toast";
import { reopenEvaluationAction } from "@/server/actions/results";

/** Controlled correction: reopen a finalized evaluation, with a reason, before results are published. */
export function ReopenEvaluation({ assessmentId, attemptId }: { assessmentId: string; attemptId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const r = await reopenEvaluationAction(assessmentId, attemptId, reason);
      if (!r.ok) return setError(r.fieldErrors?.reason?.[0] ?? r.error);
      setOpen(false);
      toast.success("Evaluation reopened", "The examiner can change the marks again.");
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Undo2 /> Reopen evaluation
      </Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reopen this evaluation?</DialogTitle>
            <DialogDescription>The assigned examiner can change the marks again. Only possible before results are marked ready or published.</DialogDescription>
          </DialogHeader>
          <Field label="Reason" htmlFor="reopen-reason" required error={error ?? undefined}>
            <Textarea id="reopen-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending}>
              Reopen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
