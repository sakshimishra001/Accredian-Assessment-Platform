"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowLeft, Ban, CheckCircle2, Clock } from "lucide-react";
import { Logo } from "@/components/proto/app-shell";
import { TERMINATION_MESSAGE } from "@/lib/learner/staff-action";
import { DetailList } from "@/components/proto/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { attemptRuleText, type SectionAttemptRule } from "@/lib/papers/rules";
import { formatDateTime, formatDuration } from "@/prototype/lib/format";
import { useToast } from "@/prototype/toast";
import { startAfterFullscreen } from "@/lib/proctoring/fullscreen-monitor";
import { startAttemptAction } from "@/server/actions/attempts";
import { CameraRequirement, liveCameraStream, useCameraLease } from "./camera";
import { liveScreenStream, ScreenRequirement, useScreenLease } from "./screen";
import { enterFullscreen, FULLSCREEN_DENIED, FULLSCREEN_UNSUPPORTED, FullscreenRequirement, leaveFullscreen, useFullscreenSupported } from "./fullscreen";
import type { getMyExamOverview } from "@/server/services/attempts";

export type ExamOverview = Awaited<ReturnType<typeof getMyExamOverview>>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Before an attempt: details, sections and instructions, then Start. After one: the submitted
 * attempt (read-only). Whether the learner may start is decided by the server when they press Start.
 */
export function ExamIntro({ overview, blocked }: { overview: ExamOverview; /** Why the running attempt can't be resumed here. */ blocked?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(blocked ?? null);
  const [pending, startTransition] = useTransition();
  const supported = useFullscreenSupported();
  const { assessment: a, sections, attempts } = overview;
  const showStart = overview.canStart || !!overview.inProgressAttemptId;
  // Camera required: the check below must be passed before Start; the exam screen takes the camera over.
  const [cameraReady, setCameraReady] = useState(false);
  useCameraLease(!!a.camera && showStart);
  // Screen monitoring (phase 7): sharing must be on before Start; the exam screen takes the share over.
  const [screenReady, setScreenReady] = useState(false);
  useScreenLease(!!a.screen && showStart);
  const last = attempts.at(-1);
  const questionCount = sections.reduce((n, s) => n + s.questionCount, 0);
  const totalMarks = Math.round(sections.reduce((m, s) => m + s.maxMarks, 0) * 100) / 100;

  function start() {
    setError(null);
    if (a.camera && !liveCameraStream()) {
      setCameraReady(false);
      setError("Your camera isn’t on. Pass the camera check again, then start the assessment.");
      return;
    }
    if (a.screen && !liveScreenStream()) {
      setScreenReady(false);
      setError("Your screen isn’t shared. Share your entire screen again, then start the assessment.");
      return;
    }
    // Fullscreen enforcement: ask for fullscreen straight from the click (browsers need the gesture)
    // and start only once the browser reports it is on.
    const fullscreen = a.fullscreen ? enterFullscreen() : null;
    startTransition(async () => {
      const attempt = await startAfterFullscreen(fullscreen, () => startAttemptAction(a.id));
      if (!attempt.started) {
        setError(attempt.reason === "unsupported" ? FULLSCREEN_UNSUPPORTED : FULLSCREEN_DENIED);
        return;
      }
      const result = attempt.result;
      if (!result.ok) {
        if (fullscreen) leaveFullscreen();
        setError(result.error);
        toast.error("You can’t start the assessment", result.error);
        router.refresh();
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="min-h-screen bg-canvas">
      <header className="flex h-14 items-center justify-between border-b bg-background px-4 md:px-6">
        <Logo />
        <Link href="/learner" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Back to dashboard
        </Link>
      </header>
      <main className="mx-auto grid max-w-3xl gap-6 px-4 py-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{a.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{a.courseName}</p>
        </div>

        {last && last.status === "TERMINATED" ? (
          <div className="rounded-lg border bg-card p-6 text-center" data-attempt-status={last.status}>
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-red-50">
              <Ban className="size-6 text-red-600" />
            </div>
            <h2 className="mt-3 text-lg font-semibold">Assessment terminated</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {TERMINATION_MESSAGE[last.terminatedBy ?? "staff"]}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Your saved responses have been recorded ({last.savedResponses} answer{last.savedResponses === 1 ? "" : "s"}). You can no longer continue this attempt.
            </p>
          </div>
        ) : last && last.status !== "IN_PROGRESS" ? (
          <div className="rounded-lg border bg-card p-6 text-center" data-attempt-status={last.status}>
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-50">
              <CheckCircle2 className="size-7 text-emerald-600" />
            </div>
            <h2 className="mt-3 text-lg font-semibold">{last.status === "AUTO_SUBMITTED" ? "Time’s up — your answers were submitted" : "Assessment submitted"}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Attempt #{last.attemptNumber} · submitted {formatDateTime(iso(last.submittedAt))} IST · {last.savedResponses} answer{last.savedResponses === 1 ? "" : "s"} saved
            </p>
            <p className="mt-2 text-sm text-muted-foreground">Your answers can no longer be changed.</p>
            <Link href={`/learner/results/${last.id}`} className={buttonVariants({ className: "mt-4" })}>
              View result
            </Link>
          </div>
        ) : null}

        <div className="rounded-lg border bg-card p-5">
          <DetailList
            items={[
              ["Duration", `${formatDuration(a.durationMinutes)}${a.timingMode === "WINDOW" ? " (ends when the window closes)" : ""}`],
              ["Total marks", String(totalMarks)],
              ["Questions", `${questionCount} in ${sections.length} section${sections.length === 1 ? "" : "s"}`],
              ["Negative marking", a.negativeMarking ? "Yes — shown on each question" : "None"],
              ["Window", `${formatDateTime(iso(a.startAt))} – ${formatDateTime(iso(a.endAt))} IST`],
              ["Attempts", `${attempts.length} of ${a.maxAttempts} used`],
            ]}
          />
        </div>

        <div className="rounded-lg border bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold">Sections</h2>
          <ul className="divide-y text-sm">
            {sections.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-medium">{s.title}</span>
                <span className="text-muted-foreground">
                  {s.questionCount} question{s.questionCount === 1 ? "" : "s"} · {attemptRuleText(s.attemptRule as SectionAttemptRule, s.attemptCount, s.itemCount)} · {s.maxMarks} marks
                </span>
              </li>
            ))}
          </ul>
        </div>

        {overview.canStart || overview.inProgressAttemptId ? (
          <div className="rounded-lg border bg-card p-5">
            <h2 className="mb-3 text-sm font-semibold">Instructions</h2>
            {a.instructions ? (
              <ul className="grid list-disc gap-1.5 pl-5 text-sm">
                {a.instructions
                  .split("\n")
                  .filter((l) => l.trim())
                  .map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No special instructions.</p>
            )}
            <ul className="mt-3 grid list-disc gap-1.5 pl-5 text-sm text-muted-foreground">
              <li>The timer is kept by the server and keeps running if you close or refresh the page.</li>
              <li>Answers save automatically. If saving fails you’ll see a warning at the top of the exam.</li>
            </ul>
            <label className="mt-5 flex items-center gap-2 text-sm">
              <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(Boolean(v))} />
              I have read and understood the instructions.
            </label>
          </div>
        ) : null}

        {a.fullscreen && (overview.canStart || overview.inProgressAttemptId) ? <FullscreenRequirement action={a.fullscreen.action} maxViolations={a.fullscreen.maxViolations} /> : null}
        {a.camera && showStart ? (
          <CameraRequirement
            action={a.camera.action}
            maxViolations={a.camera.maxViolations}
            face={!!a.camera.faceDetection}
            snapshots={a.camera.snapshots}
            onReady={() => setCameraReady(true)}
            onLost={() => setCameraReady(false)}
          />
        ) : null}
        {a.screen && showStart ? <ScreenRequirement onReady={() => setScreenReady(true)} onLost={() => setScreenReady(false)} /> : null}
        {a.clipboardMonitoring && (overview.canStart || overview.inProgressAttemptId) ? (
          <p className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Clipboard activity is monitored.</span> Copying, cutting and pasting during the exam are recorded as proctoring
            violations (only that they happened — never what you copy or paste).
          </p>
        ) : null}
        {a.fullscreen && (overview.canStart || overview.inProgressAttemptId) && !supported ? (
          <p role="alert" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
            {FULLSCREEN_UNSUPPORTED}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-900 ring-1 ring-red-200 ring-inset">
            {error}
          </p>
        ) : null}

        {overview.canStart || overview.inProgressAttemptId ? (
          <div className="flex flex-wrap items-center justify-end gap-3">
            {a.camera && !cameraReady ? <span className="text-sm text-muted-foreground">{a.camera.faceDetection ? "Pass the camera and face check above to start." : "Pass the camera check above to start."}</span> : null}
            {a.screen && !screenReady && (!a.camera || cameraReady) ? <span className="text-sm text-muted-foreground">Share your entire screen above to start.</span> : null}
            <Button size="lg" className="h-10 px-5" disabled={!agreed || pending || (!!a.camera && !cameraReady) || (!!a.screen && !screenReady)} onClick={start}>
              {pending
                ? "Starting…"
                : a.fullscreen
                  ? overview.inProgressAttemptId
                    ? "Enter Fullscreen & Resume Exam"
                    : "Enter Fullscreen & Start Exam"
                  : overview.inProgressAttemptId
                    ? "Resume assessment"
                    : attempts.length
                      ? `Start attempt #${attempts.length + 1}`
                      : "Start assessment"}
            </Button>
          </div>
        ) : !last ? (
          <p className="flex items-center gap-2 rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
            <Clock className="size-4" />
            {overview.paused
              ? "This assessment has been temporarily paused by the administrator. Please wait for it to resume."
              : new Date(overview.serverTime) < new Date(a.startAt)
                ? `This assessment opens on ${formatDateTime(iso(a.startAt))} IST.`
                : "This assessment is closed."}
          </p>
        ) : overview.attemptsLeft === 0 ? (
          <p className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">You have used all your attempts for this assessment.</p>
        ) : null}

        <div className="text-center">
          <Link href="/learner" className={buttonVariants({ variant: "ghost" })}>
            Back to dashboard
          </Link>
        </div>
      </main>
    </div>
  );
}
