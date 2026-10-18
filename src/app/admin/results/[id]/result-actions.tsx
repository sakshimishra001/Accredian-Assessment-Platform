"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/proto/controls";
import { Button } from "@/components/ui/button";
import { useToast } from "@/prototype/toast";
import { moveAssessmentAction } from "@/server/actions/results";

export interface ResultMove {
  to: string;
  label: string;
  description: string;
  ok: boolean;
  reasons: string[];
}

/** The lifecycle moves available now, as reported by the server (e.g. Start evaluation, Publish results). */
export function ResultActions({ assessmentId, actions }: { assessmentId: string; actions: ResultMove[] }) {
  const router = useRouter();
  const toast = useToast();
  const [confirm, setConfirm] = useState<ResultMove | null>(null);
  const [pending, startTransition] = useTransition();

  function run(move: ResultMove) {
    startTransition(async () => {
      const result = await moveAssessmentAction(assessmentId, move.to);
      if (!result.ok) return toast.error(`${move.label} didn’t work`, result.error);
      toast.success(`${move.label}: done`);
      router.refresh();
    });
  }

  return (
    <>
      {actions.map((m) => (
        <Button key={m.to} variant={m.to === "ENDED" ? "outline" : "default"} onClick={() => setConfirm(m)} disabled={pending || !m.ok} title={m.ok ? m.description : m.reasons.join(" ")}>
          {m.label}
        </Button>
      ))}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm ? `${confirm.label}?` : ""}
        description={confirm?.description}
        confirmLabel={confirm?.label ?? ""}
        onConfirm={() => confirm && run(confirm)}
      />
    </>
  );
}
