"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Ban, Pause, Play, Timer } from "lucide-react";
import { ConfirmDialog, Field, SelectField } from "@/components/proto/controls";
import { DetailList, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime, formatNumber } from "@/prototype/lib/format";
import { useToast } from "@/prototype/toast";
import {
  extendAttemptAction,
  extendAttemptsAction,
  pauseAssessmentAction,
  resumeAssessmentAction,
  terminateAllActiveAttemptsAction,
  terminateAttemptAction,
} from "@/server/actions/assessments";

export interface RunningAttempt {
  id: string;
  attemptNumber: number;
  startedAt: Date;
  learner: { name: string; email: string };
  savedAnswers: number;
  /** The attempt's authoritative end (duration, pauses and extensions), computed by the server. */
  effectiveEndAt: Date;
  /** Seconds left at `serverTime`. */
  remainingSeconds: number;
  extensionMinutes: number;
  /** Focus monitoring: the server's violation count, and when the limit locked the attempt. */
  focusViolations: number;
  lockedAt: Date | null;
}

export interface LiveState {
  /** ENDED only while full-duration or extended attempts are still running after the window. */
  status: "ACTIVE" | "PAUSED" | "ENDED";
  startAt: Date;
  endAt: Date;
  pausedAt: Date | null;
  /** Attempts in progress right now (from PostgreSQL). */
  runningAttempts: number;
  running: RunningAttempt[];
  /** When the server computed the remaining times. */
  serverTime: Date;
  /** Focus monitoring settings, or null when it is off. */
  focusMonitoring: { maxViolations: number; action: "LOCK" | "TERMINATE" | "WARN" } | null;
}

const REASONS = ["Technical issue", "Violation of exam rules", "Duplicate attempt", "Administrative decision", "Other"];
/** Must match the server's limit (attempt-extension.ts); the server validates regardless. */
const MAX_EXTENSION_MINUTES = 180;

const clock = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
};
const ist = (d: Date | string) => formatDateTime(new Date(d).toISOString());

/**
 * Required reason for a termination: a preset, with free text (required for "Other", optional detail
 * otherwise). The learner never sees it; it is kept with the attempt and in the audit log.
 */
function useReason() {
  const [preset, setPreset] = useState("");
  const [detail, setDetail] = useState("");
  const reason = preset === "Other" ? detail.trim() : preset ? `${preset}${detail.trim() ? ` — ${detail.trim()}` : ""}` : "";
  const ready = preset !== "" && (preset !== "Other" || detail.trim().length >= 3);
  const reset = () => {
    setPreset("");
    setDetail("");
  };
  const fields = (error?: string) => (
    <div className="grid gap-3">
      <Field label="Reason" htmlFor="term-reason" required>
        <SelectField id="term-reason" value={preset} onChange={setPreset} placeholder="Choose a reason" options={REASONS.map((r) => ({ value: r, label: r }))} />
      </Field>
      <Field label={preset === "Other" ? "Describe the reason" : "Details (optional)"} htmlFor="term-detail" error={error} hint="Kept with the attempt and in the audit log. The learner doesn’t see it.">
        <Textarea id="term-detail" rows={3} maxLength={400} value={detail} onChange={(e) => setDetail(e.target.value)} />
      </Field>
    </div>
  );
  return { reason, ready, reset, fields };
}

/** Extra minutes + a required reason, for one learner or several. */
function ExtensionFields({
  minutes,
  setMinutes,
  reason,
  setReason,
  errors,
}: {
  minutes: string;
  setMinutes: (v: string) => void;
  reason: string;
  setReason: (v: string) => void;
  errors: Record<string, string[] | undefined>;
}) {
  return (
    <div className="grid gap-3">
      <Field label="Additional time (minutes)" htmlFor="ext-minutes" required error={errors.minutes?.[0]} hint={`1–${MAX_EXTENSION_MINUTES} minutes.`}>
        <Input id="ext-minutes" type="number" inputMode="numeric" min={1} max={MAX_EXTENSION_MINUTES} step={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} className="max-w-32" />
      </Field>
      <Field label="Reason" htmlFor="ext-reason" required error={errors.reason?.[0]} hint="Kept with the attempt and in the audit log. The learner doesn’t see it.">
        <Textarea id="ext-reason" rows={2} maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Technical issue affecting the learner" />
      </Field>
    </div>
  );
}

/** Pause / resume a live assessment, extend time and terminate running attempts. The server checks everything. */
export function LiveControl({ assessmentId, assessmentName, live }: { assessmentId: string; assessmentName: string; live: LiveState }) {
  const router = useRouter();
  const toast = useToast();
  const [confirmPause, setConfirmPause] = useState(false);
  const [target, setTarget] = useState<RunningAttempt | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const single = useReason();
  const bulk = useReason();
  const paused = live.status === "PAUSED";
  const ended = live.status === "ENDED";

  // Time remaining ticks from the server's figure (frozen while paused). The page refreshes every
  // 30 seconds, re-basing it on the server and picking up learners who start, finish or are extended.
  const [elapsed, setElapsed] = useState(0);
  const serverTime = new Date(live.serverTime).getTime();
  useEffect(() => {
    const base = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - base) / 1000)), 1000);
    const refresh = setInterval(() => router.refresh(), 30_000);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
      setElapsed(0);
    };
  }, [serverTime, router]);
  const remainingOf = (r: RunningAttempt) => Math.max(0, r.remainingSeconds - (paused ? 0 : elapsed));

  // Time extensions.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [extendFor, setExtendFor] = useState<RunningAttempt | null>(null);
  const [extendBulk, setExtendBulk] = useState(false);
  const [scope, setScope] = useState<"SELECTED" | "BATCH">("BATCH");
  const [minutes, setMinutes] = useState("15");
  const [extReason, setExtReason] = useState("");
  const [extErrors, setExtErrors] = useState<Record<string, string[] | undefined>>({});
  const runningIds = new Set(live.running.map((r) => r.id));
  const chosen = [...selected].filter((id) => runningIds.has(id));

  function togglePause() {
    startTransition(async () => {
      const result = paused ? await resumeAssessmentAction(assessmentId) : await pauseAssessmentAction(assessmentId);
      if (!result.ok) toast.error(paused ? "Couldn’t resume" : "Couldn’t pause", result.error);
      else toast.success(paused ? "Assessment resumed" : "Assessment paused", paused ? "Learners can continue with the time they had left." : "Running attempts are paused and their timers have stopped.");
      router.refresh();
    });
  }

  function closeSingle() {
    setTarget(null);
    setError(undefined);
    single.reset();
  }
  function closeBulk() {
    setBulkOpen(false);
    setUnderstood(false);
    setError(undefined);
    bulk.reset();
  }
  function closeExtend() {
    setExtendFor(null);
    setExtendBulk(false);
    setExtErrors({});
    setExtReason("");
    setMinutes("15");
  }
  function openBulkExtend() {
    setScope(chosen.length ? "SELECTED" : "BATCH");
    setExtendBulk(true);
  }

  function terminateOne() {
    if (!target) return;
    startTransition(async () => {
      const result = await terminateAttemptAction(assessmentId, target.id, single.reason);
      if (!result.ok) {
        if (result.fieldErrors?.reason) return setError(result.fieldErrors.reason[0]);
        toast.error("Couldn’t terminate", result.error);
      } else toast.success("Exam terminated", `${result.data!.learnerName}’s attempt has ended.`);
      closeSingle();
      router.refresh();
    });
  }

  function terminateAll() {
    startTransition(async () => {
      const result = await terminateAllActiveAttemptsAction(assessmentId, bulk.reason);
      if (!result.ok) {
        if (result.fieldErrors?.reason) return setError(result.fieldErrors.reason[0]);
        toast.error("Couldn’t terminate", result.error);
      } else toast.success("Active attempts terminated", `${formatNumber(result.data!.terminated)} attempt${result.data!.terminated === 1 ? "" : "s"} ended.`);
      closeBulk();
      router.refresh();
    });
  }

  function extend() {
    const one = extendFor;
    startTransition(async () => {
      if (one) {
        const result = await extendAttemptAction(assessmentId, one.id, Number(minutes), extReason);
        if (!result.ok) {
          if (result.fieldErrors) return setExtErrors(result.fieldErrors);
          toast.error("Couldn’t extend the time", result.error);
        } else toast.success("Time extended", `${one.learner.name} now ends at ${ist(result.data!.newEndAt)} IST.`);
      } else {
        const result = await extendAttemptsAction(assessmentId, { scope, attemptIds: scope === "SELECTED" ? chosen : undefined, minutes: Number(minutes), reason: extReason });
        if (!result.ok) {
          if (result.fieldErrors) return setExtErrors(result.fieldErrors);
          toast.error("Couldn’t extend the time", result.error);
        } else {
          const r = result.data!;
          toast.success("Time extended", `${formatNumber(r.extended)} attempt${r.extended === 1 ? "" : "s"} extended by ${minutes} min${r.skipped ? ` · ${r.skipped} no longer running, unchanged` : ""}.`);
          setSelected(new Set());
        }
      }
      closeExtend();
      router.refresh();
    });
  }

  return (
    <Panel
      className="mb-5"
      title="Live control"
      description={
        ended
          ? "The window has closed; these attempts (full-duration or extended) are still running."
          : paused
            ? "Learners can’t answer or submit, and their timers are stopped."
            : "The assessment is open to its candidates."
      }
      actions={
        <div className="flex flex-wrap gap-2">
          {live.runningAttempts > 0 ? (
            <Button variant="outline" onClick={openBulkExtend} disabled={pending}>
              <Timer /> Extend Time
            </Button>
          ) : null}
          {live.runningAttempts > 0 ? (
            <Button variant="outline" className="text-destructive" onClick={() => setBulkOpen(true)} disabled={pending}>
              <Ban /> Terminate All Active Attempts
            </Button>
          ) : null}
          {ended ? null : (
            <Button variant={paused ? "default" : "outline"} onClick={() => setConfirmPause(true)} disabled={pending}>
              {paused ? <Play /> : <Pause />} {paused ? "Resume Assessment" : "Pause Assessment"}
            </Button>
          )}
        </div>
      }
      bodyClassName="p-0"
    >
      <div className="px-4 py-4">
        <DetailList
          className="grid-cols-[10rem_1fr]"
          items={[
            ["Status", <StatusBadge key="s" status={ended ? "Ended" : paused ? "Paused" : "Live"} />],
            ["Started", `${ist(live.startAt)} IST`],
            ...(paused && live.pausedAt ? ([["Paused at", `${ist(live.pausedAt)} IST`]] as [string, string][]) : []),
            [ended ? "Window closed" : "Window closes", `${ist(live.endAt)} IST`],
            ["Attempts in progress", formatNumber(live.runningAttempts)],
          ]}
        />
      </div>

      {live.running.length ? (
        <div className="overflow-x-auto border-t">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 pl-4">
                  <Checkbox
                    aria-label="Select all learners in progress"
                    checked={chosen.length > 0 && chosen.length === live.running.length}
                    onCheckedChange={(v) => setSelected(v === true ? new Set(live.running.map((r) => r.id)) : new Set())}
                  />
                </TableHead>
                <TableHead>Learner</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started (IST)</TableHead>
                <TableHead className="text-right">Time remaining</TableHead>
                <TableHead>Effective end (IST)</TableHead>
                <TableHead>Extension</TableHead>
                {live.focusMonitoring ? <TableHead title={`Proctoring violations: at ${live.focusMonitoring.maxViolations} the learner is ${live.focusMonitoring.action === "LOCK" ? "locked out" : live.focusMonitoring.action === "WARN" ? "warned" : "terminated"}`}>Focus</TableHead> : null}
                <TableHead className="text-right">Saved answers</TableHead>
                <TableHead className="w-44 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {live.running.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-4">
                    <Checkbox
                      aria-label={`Select ${r.learner.name}`}
                      checked={selected.has(r.id)}
                      onCheckedChange={(v) =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (v === true) next.add(r.id);
                          else next.delete(r.id);
                          return next;
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{r.learner.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.learner.email}
                      {r.attemptNumber > 1 ? ` · attempt #${r.attemptNumber}` : ""}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.lockedAt ? "Locked" : paused ? "Paused" : "In progress"} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{ist(r.startedAt)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{clock(remainingOf(r))}</TableCell>
                  <TableCell className="text-muted-foreground">{ist(r.effectiveEndAt)}</TableCell>
                  <TableCell className="text-muted-foreground">{r.extensionMinutes ? `+${r.extensionMinutes} min` : "—"}</TableCell>
                  {live.focusMonitoring ? (
                    <TableCell className={r.focusViolations ? "font-medium text-amber-700 tabular-nums" : "text-muted-foreground tabular-nums"}>
                      {r.focusViolations}/{live.focusMonitoring.maxViolations}
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right tabular-nums">{r.savedAnswers}</TableCell>
                  <TableCell className="pr-4 text-right whitespace-nowrap">
                    <Button size="sm" variant="outline" className="mr-2" onClick={() => setExtendFor(r)} disabled={pending} aria-label={`Extend ${r.learner.name}’s time`}>
                      Extend
                    </Button>
                    <Button size="sm" variant="outline" className="text-destructive" onClick={() => setTarget(r)} disabled={pending} aria-label={`Terminate ${r.learner.name}’s exam`}>
                      Terminate
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <Dialog open={extendFor !== null} onOpenChange={(o) => !o && !pending && closeExtend()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Extend time</DialogTitle>
            <DialogDescription>The extra time is added to this learner’s attempt only, and may run past the assessment’s end time.</DialogDescription>
          </DialogHeader>
          <DetailList
            className="grid-cols-[9rem_1fr]"
            items={[
              ["Learner", extendFor ? `${extendFor.learner.name} (${extendFor.learner.email})` : ""],
              ["Current effective end", extendFor ? `${ist(extendFor.effectiveEndAt)} IST` : ""],
              ["Extension so far", extendFor?.extensionMinutes ? `+${extendFor.extensionMinutes} min` : "None"],
            ]}
          />
          <ExtensionFields minutes={minutes} setMinutes={setMinutes} reason={extReason} setReason={setExtReason} errors={extErrors} />
          <DialogFooter>
            <Button variant="outline" onClick={closeExtend} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={extend} disabled={pending || !minutes || extReason.trim().length < 3}>
              {pending ? "Extending…" : "Confirm Extension"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={extendBulk} onOpenChange={(o) => !o && !pending && closeExtend()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Extend time</DialogTitle>
            <DialogDescription>Only attempts in progress are extended. Submitted or terminated attempts and learners who haven’t started are not affected.</DialogDescription>
          </DialogHeader>
          <fieldset className="grid gap-2 text-sm">
            <legend className="mb-1 font-medium">Scope</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="ext-scope" checked={scope === "SELECTED"} onChange={() => setScope("SELECTED")} disabled={chosen.length === 0} />
              Selected learners ({formatNumber(chosen.length)})
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="ext-scope" checked={scope === "BATCH"} onChange={() => setScope("BATCH")} />
              Entire batch — everyone in progress now ({formatNumber(live.runningAttempts)})
            </label>
          </fieldset>
          <ExtensionFields minutes={minutes} setMinutes={setMinutes} reason={extReason} setReason={setExtReason} errors={extErrors} />
          <DialogFooter>
            <Button variant="outline" onClick={closeExtend} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={extend} disabled={pending || !minutes || extReason.trim().length < 3 || (scope === "SELECTED" && chosen.length === 0)}>
              {pending ? "Extending…" : "Confirm Extension"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmPause}
        onOpenChange={setConfirmPause}
        title={paused ? "Resume the assessment?" : "Pause the assessment?"}
        description={
          paused
            ? "Learners continue where they stopped, with the time they had left when it was paused (the window’s end time still applies)."
            : `All ${formatNumber(live.runningAttempts)} attempt(s) in progress are paused: learners see a paused screen, can’t answer or submit, and their timers stop. Saved answers are kept. The window’s end time doesn’t change.`
        }
        confirmLabel={paused ? "Resume Assessment" : "Pause Assessment"}
        destructive={!paused}
        onConfirm={togglePause}
      />

      <Dialog open={target !== null} onOpenChange={(o) => !o && !pending && closeSingle()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Terminate exam?</DialogTitle>
            <DialogDescription>This immediately ends the learner’s assessment. They won’t be able to continue this attempt. Their saved answers are kept.</DialogDescription>
          </DialogHeader>
          <DetailList
            className="grid-cols-[6rem_1fr]"
            items={[
              ["Learner", target ? `${target.learner.name} (${target.learner.email})` : ""],
              ["Assessment", assessmentName],
            ]}
          />
          {single.fields(error)}
          <DialogFooter>
            <Button variant="outline" onClick={closeSingle} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={terminateOne} disabled={pending || !single.ready}>
              {pending ? "Terminating…" : "Terminate Exam"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkOpen} onOpenChange={(o) => !o && !pending && closeBulk()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Terminate all active attempts?</DialogTitle>
            <DialogDescription>
              This terminates every attempt in progress right now. Submitted attempts and learners who haven’t started are not affected. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DetailList
            className="grid-cols-[8rem_1fr]"
            items={[
              ["Assessment", assessmentName],
              ["Affected learners", formatNumber(live.runningAttempts)],
            ]}
          />
          {bulk.fields(error)}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={understood} onCheckedChange={(v) => setUnderstood(v === true)} aria-label="I understand this ends every active attempt and cannot be undone" />
            <span>I understand this ends every active attempt and cannot be undone.</span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={closeBulk} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={terminateAll} disabled={pending || !bulk.ready || !understood}>
              {pending ? "Terminating…" : "Terminate All"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
