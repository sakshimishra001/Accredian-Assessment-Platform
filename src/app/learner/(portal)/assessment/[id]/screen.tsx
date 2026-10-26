"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, MonitorUp, MonitorX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { expectNativeDialog } from "@/lib/proctoring/expected-interactions";
import { SCREEN_CONSTRAINTS, SCREEN_PROBLEM_MESSAGE, SCREEN_STATUS_TEXT, screenProblem, sharedSurfaceOk, type ScreenProblem, type ScreenShareStatus } from "@/lib/proctoring/screen-monitor";
import { policyAllows, usePolicyReload } from "./camera";

/*
 * Screen sharing in the learner's exam (proctoring evidence, phase 7), with the standard
 * getDisplayMedia API: the learner chooses to share in the browser's own picker — nothing bypasses
 * it — and the whole screen is asked for. Video only, at a low frame rate; the stream is never
 * recorded, streamed or uploaded: still snapshots are taken at randomized times (frame-capture.ts)
 * and kept as proctoring evidence. The learner is told all of this before starting.
 *
 * One stream per page, like the camera: the pre-exam step opens it and the exam screen takes it over.
 * A reload ends the share; the exam then asks for it again, without hiding the questions.
 */

let shared: MediaStream | null = null;
let pendingStop: ReturnType<typeof setTimeout> | null = null;

const live = (s: MediaStream | null) => !!s && s.getVideoTracks().some((t) => t.readyState === "live");

/** The page's screen-share stream, if it is still live. */
export const liveScreenStream = (): MediaStream | null => (typeof window !== "undefined" && live(shared) ? shared : null);

/** Stop sharing (every track stopped, so the browser's sharing indicator goes away). */
export function stopScreen() {
  if (pendingStop) clearTimeout(pendingStop);
  pendingStop = null;
  for (const track of shared?.getTracks() ?? []) track.stop();
  shared = null;
}

export type ScreenOpened = { ok: true; stream: MediaStream } | { ok: false; problem: ScreenProblem };

/** Ask the learner to share their screen (the browser's picker). Must be called from a click. */
export async function openScreen(): Promise<ScreenOpened> {
  if (!window.isSecureContext) return { ok: false, problem: "insecure" };
  if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") return { ok: false, problem: "unsupported" };
  if (policyAllows("display-capture") === false) return { ok: false, problem: "blocked" };
  // The browser's picker takes focus while it is open: not leaving the exam.
  const pickerClosed = expectNativeDialog("permission-prompt");
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(SCREEN_CONSTRAINTS as DisplayMediaStreamOptions);
    for (const track of stream.getAudioTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
    // The whole screen only: a window or a tab would hide everything else.
    if (!sharedSurfaceOk(stream.getVideoTracks()[0]?.getSettings() as { displaySurface?: string })) {
      for (const track of stream.getTracks()) track.stop();
      return { ok: false, problem: "wrong-surface" };
    }
    stopScreen();
    shared = stream;
    return { ok: true, stream };
  } catch (err) {
    return { ok: false, problem: screenProblem(err) };
  } finally {
    pickerClosed();
  }
}

/** Keeps the share while a screen that needs it is mounted; stops it when the learner leaves (after a moment, so the hand-over to the exam keeps it). */
export function useScreenLease(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    if (pendingStop) clearTimeout(pendingStop);
    pendingStop = null;
    return () => {
      if (pendingStop) clearTimeout(pendingStop);
      pendingStop = setTimeout(stopScreen, 0);
    };
  }, [enabled]);
}

/** A small status chip: Not requested / Permission requested / Sharing / Permission denied / Sharing stopped. */
export function ScreenStatusChip({ status }: { status: ScreenShareStatus }) {
  const ok = status === "sharing";
  const bad = status === "denied" || status === "stopped";
  return (
    <span
      data-screen-status={status}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${ok ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : bad ? "bg-amber-50 text-amber-900 ring-amber-200" : "bg-muted text-muted-foreground ring-border"}`}
    >
      {status === "requesting" ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <span aria-hidden className={`size-1.5 rounded-full ${ok ? "bg-emerald-500" : bad ? "bg-amber-500" : "bg-muted-foreground/50"}`} />}
      Screen: {SCREEN_STATUS_TEXT[status]}
    </span>
  );
}

/** Before the exam: what screen monitoring means, then sharing. Start is allowed only while sharing. */
export function ScreenRequirement({ onReady, onLost }: { onReady: () => void; onLost: () => void }) {
  usePolicyReload("display-capture");
  const [status, setStatus] = useState<ScreenShareStatus>(() => (liveScreenStream() ? "sharing" : "not-requested"));
  const [problem, setProblem] = useState<ScreenProblem | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(() => liveScreenStream());

  // Sharing stops (the browser's "Stop sharing", the source closed) before the exam starts.
  useEffect(() => {
    if (!stream) return;
    const tracks = stream.getVideoTracks();
    const ended = () => {
      setStream(null);
      setStatus("stopped");
      onLost();
    };
    for (const t of tracks) t.addEventListener("ended", ended);
    return () => {
      for (const t of tracks) t.removeEventListener("ended", ended);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one watcher per stream
  }, [stream]);

  useEffect(() => {
    if (stream) onReady();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- already sharing when mounted
  }, []);

  async function share() {
    setProblem(null);
    setStatus("requesting");
    const r = await openScreen();
    if (r.ok) {
      setStream(r.stream);
      setStatus("sharing");
      onReady();
    } else {
      setProblem(r.problem);
      setStatus(r.problem === "denied" ? "denied" : stream ? "sharing" : "not-requested");
    }
  }

  return (
    <section aria-labelledby="screen-title" className="rounded-xl border bg-card p-5">
      <h2 id="screen-title" className="flex items-center gap-2 text-base font-semibold">
        <MonitorUp className="size-4 text-primary" aria-hidden /> Screen sharing is required for this assessment
      </h2>
      <ul className="mt-3 grid list-disc gap-1.5 pl-5 text-sm text-muted-foreground">
        <li className="font-medium text-foreground">
          Screen monitoring is active: still snapshots of your shared screen are taken from time to time during the exam (at varying times) and kept as proctoring evidence.
        </li>
        <li>Your browser will ask what to share. Choose your <span className="font-medium text-foreground">entire screen</span> — not a single window or tab — then select Share.</li>
        <li>Snapshots can be viewed only by the assessment’s administrators and assigned proctors, for assessment integrity. No video or audio is recorded or streamed.</li>
        <li>Close anything on your screen you don’t want captured before you start.</li>
        <li>Keep sharing until you submit. If sharing stops, you’ll be asked to share again; it is recorded and shown to the proctor, but your exam continues.</li>
        <li>Sharing permission is controlled by your browser; you can stop sharing at any time from the browser’s sharing bar.</li>
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
        <ScreenStatusChip status={status} />
        {status !== "sharing" ? (
          <Button type="button" variant={status === "not-requested" ? "default" : "outline"} onClick={() => void share()} disabled={status === "requesting"}>
            <MonitorUp /> {status === "not-requested" ? "Share screen" : "Share screen again"}
          </Button>
        ) : (
          <span className="flex items-center gap-1.5 text-sm font-medium text-emerald-700">
            <CheckCircle2 className="size-4" aria-hidden /> Your screen is shared.
          </span>
        )}
      </div>
      {problem ? (
        <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-900 ring-1 ring-red-200 ring-inset">
          {SCREEN_PROBLEM_MESSAGE[problem]}
        </p>
      ) : null}
    </section>
  );
}

/**
 * During the exam, while the screen isn't shared: a warning with a button to share again. It never
 * hides the questions or stops autosave, navigation, the timer or submission.
 */
export function ScreenShareBanner({ status, problem, onShare }: { status: ScreenShareStatus; problem: ScreenProblem | null; onShare: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      <MonitorX className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {status === "denied"
          ? "Screen sharing wasn’t allowed. This assessment requires your entire screen to be shared."
          : status === "stopped"
            ? "Screen sharing stopped. This assessment requires your entire screen to be shared — it has been recorded for the proctor."
            : "This assessment requires your entire screen to be shared."}{" "}
        Your answers are saved and the exam continues.
        {problem && problem !== "denied" ? <span className="mt-0.5 block text-xs">{SCREEN_PROBLEM_MESSAGE[problem]}</span> : null}
      </span>
      <Button type="button" size="sm" variant="outline" onClick={onShare} disabled={status === "requesting"}>
        {status === "requesting" ? <Loader2 className="animate-spin" /> : <MonitorUp />} Share screen
      </Button>
    </div>
  );
}
