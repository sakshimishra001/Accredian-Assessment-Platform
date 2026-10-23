"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Ban, Lock } from "lucide-react";
import { Field } from "@/components/proto/controls";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/prototype/toast";
import { lockAttemptAction, terminateMonitoredAttemptAction } from "@/server/actions/proctor";

type Kind = "lock" | "terminate";

const COPY: Record<Kind, { title: string; description: string; label: string; confirm: string; done: (name: string) => string }> = {
  lock: {
    title: "Lock this attempt?",
    description: "The learner can no longer change or submit answers. Their saved answers are kept and the attempt closes at its deadline. There is no unlock.",
    label: "Reason for locking",
    confirm: "Lock Attempt",
    done: (name) => `${name}’s attempt is locked`,
  },
  terminate: {
    title: "Terminate this attempt?",
    description: "The attempt ends now and can’t be continued or submitted. Saved answers are kept, but a terminated attempt isn’t evaluated. This can’t be undone.",
    label: "Reason for termination",
    confirm: "Terminate Attempt",
    done: (name) => `${name}’s attempt is terminated`,
  },
};

/**
 * Lock / terminate one running attempt. A reason is required (kept with the attempt and in the audit
 * log; the learner never sees it). The server checks everything again — who may act, that the
 * attempt belongs to this assessment and is still running.
 */
export function AttemptActions({ assessmentId, attemptId, learnerName, locked }: { assessmentId: string; attemptId: string; learnerName: string; locked: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState<Kind | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const valid = reason.trim().length >= 3;

  function show(kind: Kind) {
    setReason("");
    setError(null);
    setOpen(kind);
  }

  function confirm() {
    if (!open || !valid) return;
    const kind = open;
    startTransition(async () => {
      const result = kind === "lock" ? await lockAttemptAction(assessmentId, attemptId, reason) : await terminateMonitoredAttemptAction(assessmentId, attemptId, reason);
      if (!result.ok) {
        setError(result.fieldErrors?.reason?.[0] ?? result.error);
        return;
      }
      toast.success(COPY[kind].done(result.data?.learnerName ?? learnerName));
      setOpen(null);
      router.refresh();
    });
  }

  const copy = open ? COPY[open] : null;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => show("lock")} disabled={locked || pending} title={locked ? "This attempt is already locked" : undefined}>
          <Lock /> Lock Attempt
        </Button>
        <Button variant="destructive" onClick={() => show("terminate")} disabled={pending}>
          <Ban /> Terminate Attempt
        </Button>
      </div>

      <Dialog open={open !== null} onOpenChange={(o) => !o && !pending && setOpen(null)}>
        <DialogContent className="sm:max-w-md">
          {copy ? (
            <>
              <DialogHeader>
                <DialogTitle>{copy.title}</DialogTitle>
                <DialogDescription>
                  {learnerName}. {copy.description}
                </DialogDescription>
              </DialogHeader>
              <Field label={copy.label} htmlFor="action-reason" required error={error} hint="Kept with the attempt and in the audit log. The learner doesn’t see it.">
                <Textarea id="action-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={open === "lock" ? "e.g. Repeatedly leaving the exam" : "e.g. Another person answering the questions"} />
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(null)} disabled={pending}>
                  Cancel
                </Button>
                <Button
                  onClick={confirm}
                  disabled={!valid || pending}
                  className={open === "terminate" ? "bg-destructive text-white hover:bg-destructive/90" : undefined}
                >
                  {open === "lock" ? <Lock /> : <Ban />} {pending ? "Working…" : copy.confirm}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
