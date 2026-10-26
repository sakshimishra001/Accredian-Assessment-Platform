"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, CheckCircle2, Loader2, Minimize2, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CAMERA_CONSTRAINTS, CAMERA_PROBLEM_MESSAGE, cameraProblem, streamIsLive, type CameraProblem } from "@/lib/proctoring/camera-monitor";
import { countFaces, type FaceStatus } from "@/lib/proctoring/face-monitor";
import { expectNativeDialog } from "@/lib/proctoring/expected-interactions";
import { loadFaceDetector, startFaceSampling } from "./face-detector";
import type { Action } from "./fullscreen";

/*
 * The camera in the learner's exam (proctoring with "Require camera"), with the standard
 * getUserMedia API. Video only — the microphone is never requested. The live stream is shown back to
 * the learner on their own screen and nowhere else; it is never recorded, streamed or uploaded. With
 * camera snapshots on (phase 7), a still frame is taken at randomized times and kept as proctoring
 * evidence — the learner is told before starting (see frame-capture.ts and the notices below).
 *
 * One stream per page: the pre-exam check opens it and the exam screen takes it over when the
 * attempt starts (same page, no new permission prompt). A reload starts with no stream, so the
 * learner passes the check again before the questions are shown.
 */

let shared: MediaStream | null = null;
let pendingStop: ReturnType<typeof setTimeout> | null = null;

/** The page's camera stream, if it is still working. */
export const liveCameraStream = (): MediaStream | null => (typeof window !== "undefined" && streamIsLive(shared) ? shared : null);

/** Turn the camera off (every track stopped, so the browser's camera light goes out). */
export function stopCamera() {
  if (pendingStop) clearTimeout(pendingStop);
  pendingStop = null;
  for (const track of shared?.getTracks() ?? []) track.stop();
  shared = null;
}

/** The camera permission's state now (null: this browser can't say). */
export async function cameraPermission(): Promise<PermissionState | null> {
  try {
    return (await navigator.permissions.query({ name: "camera" as PermissionName })).state;
  } catch {
    return null;
  }
}

type Opened ={ ok: true; stream: MediaStream } | { ok: false; problem: CameraProblem };

/** The Permissions-Policy the page was loaded with allows a feature (null: the browser doesn't say). */
export function policyAllows(feature: "camera" | "display-capture"): boolean | null {
  const d = document as Document & { permissionsPolicy?: { allowsFeature(f: string): boolean }; featurePolicy?: { allowsFeature(f: string): boolean } };
  const policy = d.permissionsPolicy ?? d.featurePolicy;
  return policy ? policy.allowsFeature(feature) : null;
}
const policyAllowsCamera = () => policyAllows("camera");

/** Ask for the camera (the browser shows its permission prompt the first time). Never assumes success. */
export async function openCamera(): Promise<Opened> {
  stopCamera();
  if (!window.isSecureContext) return { ok: false, problem: "insecure" };
  if (typeof navigator.mediaDevices?.getUserMedia !== "function") return { ok: false, problem: "unsupported" };
  if (policyAllowsCamera() === false) return { ok: false, problem: "blocked" };
  // The browser's permission prompt takes focus while it is open: not leaving the exam.
  const promptClosed = expectNativeDialog("permission-prompt");
  try {
    const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    // Only video was asked for; drop anything else a browser might hand back.
    for (const track of stream.getAudioTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
    shared = stream;
    return { ok: true, stream };
  } catch (err) {
    return { ok: false, problem: cameraProblem(err) };
  } finally {
    promptClosed();
  }
}

const RELOAD_KEY = "camera-policy-reload";

/**
 * The exam page allows the camera (and screen capture), but a page reached by an in-app (client-side)
 * navigation keeps the Permissions-Policy of the page it started on, which doesn't. Reload once so
 * the exam page's own policy applies (the exam's state is all on the server, so nothing is lost).
 */
export function usePolicyReload(feature: "camera" | "display-capture" = "camera") {
  useEffect(() => {
    if (policyAllows(feature) !== false) {
      try {
        sessionStorage.removeItem(RELOAD_KEY);
      } catch {}
      return;
    }
    try {
      if (sessionStorage.getItem(RELOAD_KEY) === location.pathname) return; // Already tried: show "blocked".
      sessionStorage.setItem(RELOAD_KEY, location.pathname);
    } catch {
      return;
    }
    location.reload();
  }, [feature]);
}
const useCameraPolicyReload = () => usePolicyReload("camera");

/**
 * Keeps the camera on while a camera screen (the pre-exam check, the exam) is mounted and turns it
 * off when the learner leaves. The stop waits a moment, so the hand-over from the pre-exam check to
 * the exam screen (and React's development double-mount) doesn't turn the camera off.
 */
export function useCameraLease(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    if (pendingStop) clearTimeout(pendingStop);
    pendingStop = null;
    return () => {
      if (pendingStop) clearTimeout(pendingStop);
      pendingStop = setTimeout(stopCamera, 0);
    };
  }, [enabled]);
}

/** The learner's own camera, mirrored. Calls `onFrames` once the camera is actually delivering video. */
export function CameraPreview({ stream, onFrames, className }: { stream: MediaStream; onFrames?: () => void; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const framesRef = useRef(onFrames);
  useEffect(() => {
    framesRef.current = onFrames;
  });
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    const check = () => {
      if (video.videoWidth > 0) framesRef.current?.();
    };
    video.addEventListener("loadeddata", check);
    video.addEventListener("resize", check);
    void video.play().catch(() => {});
    return () => {
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("resize", check);
      video.srcObject = null;
    };
  }, [stream]);
  return <video ref={ref} autoPlay muted playsInline disablePictureInPicture aria-label="Your camera preview (visible only to you)" className={`-scale-x-100 bg-black object-cover ${className ?? ""}`} />;
}

/** No video within this long after access was granted: the camera isn't working. */
const FRAMES_TIMEOUT_MS = 10_000;

type CheckState = { kind: "idle" } | { kind: "requesting" } | { kind: "starting"; stream: MediaStream } | { kind: "ready"; stream: MediaStream } | { kind: "failed"; problem: CameraProblem };

/** The pre-exam face check: loading the detector, unable to load it, or the faces in the latest samples. */
type FaceCheck = { kind: "loading" } | { kind: "failed" } | { kind: "seen"; faces: number; oneFaceStreak: number };
/** Exactly one face in this many consecutive samples (about a second) passes the face check. */
const ONE_FACE_SAMPLES = 2;

/**
 * The camera check: ask for the camera, show the preview, and pass once real video arrives — and,
 * with `face`, once exactly one face is visible (detected in this browser; nothing leaves it).
 * `onReady` — passed (with the working stream); `onLost` — a passed check no longer holds.
 */
function CameraCheck({ onReady, onLost, face = false }: { onReady: (stream: MediaStream) => void; onLost?: () => void; face?: boolean }) {
  useCameraPolicyReload();
  const [state, setState] = useState<CheckState>({ kind: "idle" });
  const [faces, setFaces] = useState<FaceCheck>({ kind: "loading" });
  const stream = state.kind === "starting" || state.kind === "ready" ? state.stream : null;
  const readyStream = state.kind === "ready" ? state.stream : null;
  const faceOk = faces.kind === "seen" && faces.faces === 1 && faces.oneFaceStreak >= ONE_FACE_SAMPLES;
  const passed = !!readyStream && (!face || faceOk);

  // Fetch the face detector (our own static files) while the learner reads, not after they allow the camera.
  useEffect(() => {
    if (face) void loadFaceDetector().catch(() => {});
  }, [face]);

  // With the camera on: look for exactly one face, about twice a second, on this device only.
  useEffect(() => {
    if (!face || !readyStream) return;
    const stop = startFaceSampling(readyStream, {
      shouldSample: () => document.visibilityState === "visible",
      onSample: (_now, sample) =>
        setFaces((prev) => {
          const n = countFaces(sample);
          return { kind: "seen", faces: n, oneFaceStreak: n === 1 ? (prev.kind === "seen" && prev.faces === 1 ? prev.oneFaceStreak + 1 : 1) : 0 };
        }),
      onUnavailable: () => setFaces({ kind: "failed" }),
    });
    return () => {
      stop();
      // A new camera stream starts the face check afresh.
      setFaces({ kind: "loading" });
    };
  }, [face, readyStream]);

  // Tell the page when the check passes, and when a passed check stops holding.
  const wasPassed = useRef(false);
  useEffect(() => {
    if (passed && !wasPassed.current && readyStream) onReady(readyStream);
    if (!passed && wasPassed.current) onLost?.();
    wasPassed.current = passed;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on a change of outcome
  }, [passed, readyStream]);

  async function request() {
    setState({ kind: "requesting" });
    const r = await openCamera();
    setState(r.ok ? { kind: "starting", stream: r.stream } : { kind: "failed", problem: r.problem });
  }

  // The camera stops (unplugged, turned off, permission revoked) during the check: fail it.
  useEffect(() => {
    if (!stream) return;
    const tracks = stream.getVideoTracks();
    const ended = () => {
      if (stream === shared) stopCamera();
      setState({ kind: "failed", problem: "unavailable" });
    };
    for (const t of tracks) t.addEventListener("ended", ended);
    return () => {
      for (const t of tracks) t.removeEventListener("ended", ended);
    };
  }, [stream]);

  // Access granted but no video arrives: the camera isn't usable.
  useEffect(() => {
    if (state.kind !== "starting") return;
    const t = setTimeout(() => {
      if (state.stream === shared) stopCamera();
      setState({ kind: "failed", problem: "unavailable" });
    }, FRAMES_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [state]);

  function framesArrived() {
    if (state.kind !== "starting" || !streamIsLive(state.stream)) return;
    setState({ kind: "ready", stream: state.stream });
  }

  return (
    <div className="grid gap-3 sm:grid-cols-[14rem_1fr] sm:items-start">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border bg-muted">
        {stream ? (
          <CameraPreview stream={stream} onFrames={framesArrived} className="size-full" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            {state.kind === "failed" ? <CameraOff className="size-8" aria-hidden /> : <Camera className="size-8" aria-hidden />}
          </div>
        )}
      </div>
      <div className="grid gap-3 text-sm" aria-live="polite">
        {state.kind === "ready" ? (
          <>
            <p className="flex items-center gap-2 font-medium text-emerald-700">
              <CheckCircle2 className="size-4" aria-hidden /> {face ? "Camera is ready." : "Camera is ready. Make sure your face is clearly visible."}
            </p>
            {face ? <FaceCheckStatus faces={faces} ok={faceOk} /> : null}
          </>
        ) : state.kind === "starting" ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Starting your camera…
          </p>
        ) : state.kind === "requesting" ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Waiting for camera permission — select <span className="font-medium text-foreground">Allow</span> in your browser’s prompt.
          </p>
        ) : state.kind === "failed" ? (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-900 ring-1 ring-red-200 ring-inset">
            {CAMERA_PROBLEM_MESSAGE[state.problem]}
          </p>
        ) : (
          <p className="text-muted-foreground">Select the button below, then allow camera access when your browser asks.</p>
        )}
        {state.kind === "idle" || state.kind === "failed" ? (
          <div>
            <Button type="button" variant={state.kind === "failed" ? "outline" : "default"} onClick={() => void request()}>
              <Camera /> {state.kind === "failed" ? "Try again" : "Allow camera access"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The pre-exam face check's state, in plain words (never a verdict about the learner). */
function FaceCheckStatus({ faces, ok }: { faces: FaceCheck; ok: boolean }) {
  if (faces.kind === "loading") {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading the face check…
      </p>
    );
  }
  if (faces.kind === "failed") {
    return (
      <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-900 ring-1 ring-red-200 ring-inset">
        The face check couldn’t be started on this device, so the assessment can’t begin yet. Reload the page and try again; if it keeps happening, contact your administrator.
      </p>
    );
  }
  if (ok) {
    return (
      <p className="flex items-center gap-2 font-medium text-emerald-700" data-face-check="ok">
        <CheckCircle2 className="size-4" aria-hidden /> One face visible ✓
      </p>
    );
  }
  if (faces.faces === 0) {
    return <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900 ring-1 ring-amber-200 ring-inset">No face detected — sit facing the camera, in good light, with your whole face visible.</p>;
  }
  if (faces.faces > 1) {
    return <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900 ring-1 ring-amber-200 ring-inset">More than one face is visible — please make sure only you are in view of the camera.</p>;
  }
  return (
    <p className="flex items-center gap-2 text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden /> Checking…
    </p>
  );
}

/**
 * Before the exam: what the camera requirement (and face check) means, then the check itself. Camera
 * and face problems are recorded for the proctor but never counted as violations (the violation
 * policy applies to focus, fullscreen and clipboard only), so the policy isn't repeated here.
 */
export function CameraRequirement({
  face = false,
  snapshots = false,
  onReady,
  onLost,
}: {
  action: Action;
  maxViolations: number;
  /** Face detection is on: the check also needs exactly one face in view. */
  face?: boolean;
  /** Camera snapshots are kept as proctoring evidence (phase 7). */
  snapshots?: boolean;
  onReady: (stream: MediaStream) => void;
  onLost: () => void;
}) {
  return (
    <section aria-labelledby="camera-title" className="rounded-xl border bg-card p-5">
      <h2 id="camera-title" className="flex items-center gap-2 text-base font-semibold">
        <Video className="size-4 text-primary" aria-hidden /> Your camera is required for this assessment
      </h2>
      <ul className="mt-3 grid list-disc gap-1.5 pl-5 text-sm text-muted-foreground">
        <li>Your browser will ask for permission to use your camera. Select Allow. Only the camera is used — your microphone is never requested.</li>
        {snapshots ? (
          <>
            <li className="font-medium text-foreground">
              Camera monitoring is active: still snapshots from your camera are taken from time to time during the exam (at varying times) and kept as proctoring evidence.
            </li>
            <li>Snapshots can be viewed only by the assessment’s administrators and assigned proctors, for assessment integrity. No video is recorded or streamed.</li>
          </>
        ) : (
          <li>Your camera is shown only to you, on this screen. No video, photos or images of you are recorded, uploaded or stored.</li>
        )}
        {face ? (
          <>
            <li>
              Your camera is also used to check that one face is in view. This check runs only on this device{snapshots ? " (separately from the snapshots above)" : ""}: no image or video is sent
              for it, and you are not identified.
            </li>
            <li>Before you start, sit facing the camera in good light with your whole face visible, and make sure no one else is in view.</li>
            <li>During the exam, if no face is visible for more than a few seconds, or another person stays in view, it is recorded for the proctor (it isn’t counted as a violation).</li>
          </>
        ) : null}
        <li>Keep your camera on until you submit. If it turns off, is disconnected or camera access is blocked, it is recorded for the proctor (it isn’t counted as a violation).</li>
        <li>If your camera stops during the exam, you can keep answering — a warning asks you to turn it back on. The timer keeps running.</li>
        <li>The camera turns off as soon as you submit or the exam ends.</li>
      </ul>
      <div className="mt-4 border-t pt-4">
        <h3 className="mb-3 text-sm font-semibold">{face ? "Camera and face check" : "Camera check"}</h3>
        <CameraCheck onReady={onReady} onLost={onLost} face={face} />
      </div>
    </section>
  );
}

/**
 * During the exam, while the camera isn't on: a prominent warning that never hides the questions —
 * the learner keeps answering, saving, navigating and can submit. "Restore camera" opens the camera
 * check (CameraGate). `lost` — it just stopped; otherwise it isn't on yet (after a reload or resume).
 */
export function CameraWarningBanner({ lost, denied, onRestore }: { lost: boolean; denied: boolean; onRestore: () => void }) {
  return (
    <div role="alert" data-camera-warning className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      <CameraOff className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{denied ? "Camera access blocked." : lost ? "Camera unavailable." : "Camera is off."}</span> Please restore camera access. Your assessment can continue, but
        proctoring may be affected.
      </span>
      <span className="inline-flex items-center gap-1.5 text-xs font-medium" data-camera-status={denied ? "denied" : "off"}>
        <span aria-hidden className="size-1.5 rounded-full bg-amber-500" /> Camera: {denied ? "Permission denied" : "Off"}
      </span>
      <Button type="button" size="sm" variant="outline" onClick={onRestore}>
        <Camera /> Restore camera
      </Button>
    </div>
  );
}

/**
 * The camera recovery check, opened by the learner from the camera warning: pass the camera check
 * again to turn the camera back on. It can be closed at any time ("Back to the questions") — the
 * exam never waits for it. `lost` — it just stopped; otherwise it isn't on yet (after a reload).
 */
export function CameraGate({
  lost,
  snapshots = false,
  onReturn,
  onClose,
}: {
  lost: boolean;
  /** Camera snapshots are kept as proctoring evidence (phase 7). */
  snapshots?: boolean;
  onReturn: (stream: MediaStream) => void;
  /** Back to the questions without the camera. */
  onClose: () => void;
}) {
  const [ready, setReady] = useState<MediaStream | null>(null);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-background/80 px-4 py-6 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="camgate-title" aria-describedby="camgate-body">
      <div className="w-full max-w-xl rounded-xl border bg-card p-7 shadow-sm">
        <div className="text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-amber-50 text-amber-700">
            <CameraOff className="size-6" aria-hidden />
          </span>
          <h2 id="camgate-title" className="mt-4 text-lg font-semibold tracking-tight">
            {lost ? "Your camera turned off" : "Turn on your camera"}
          </h2>
          <div id="camgate-body" className="mt-2 grid gap-2 text-sm text-muted-foreground">
            <p>Pass the camera check to turn your camera back on. Your assessment can continue meanwhile — your answers are saved and the timer keeps running.</p>
            <p>
              {snapshots
                ? "Snapshots from your camera are taken from time to time and kept as proctoring evidence; no video is recorded. Your microphone is never used."
                : "Your camera is shown only to you; nothing is recorded or stored. Your microphone is never used."}
            </p>
          </div>
        </div>
        <div className="mt-5 text-left">
          <CameraCheck onReady={setReady} onLost={() => setReady(null)} />
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Back to the questions
          </Button>
          <Button disabled={!ready || !streamIsLive(ready)} onClick={() => ready && onReturn(ready)} autoFocus>
            Continue with camera on
          </Button>
        </div>
      </div>
    </div>
  );
}

/** What the face check currently sees, for the learner (status only — never a verdict). */
export const FACE_STATUS_TEXT: Record<FaceStatus, string> = {
  starting: "Checking for your face…",
  detected: "Face detected",
  missing: "Face not detected — please face the camera",
  multiple: "Multiple faces detected",
  unavailable: "Face check unavailable",
};

/** During the exam: the learner's own camera in a corner, so they can see they're in view (and, with face detection, what the check sees). */
export function CameraPip({ stream, face = null, snapshots = false }: { stream: MediaStream; face?: FaceStatus | null; snapshots?: boolean }) {
  const [small, setSmall] = useState(false);
  const attention = face === "missing" || face === "multiple";
  return (
    <div className="fixed bottom-4 left-4 z-30 max-w-[15rem] overflow-hidden rounded-lg border bg-card shadow-md">
      <div className="flex items-center justify-between gap-2 px-2 py-1 text-[11px] font-medium text-muted-foreground">
        <span className="grid gap-0.5">
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden /> {snapshots ? "Camera monitoring on · snapshots may be taken" : "Camera on · only you see this"}
          </span>
          {face ? (
            <span role="status" data-face-status={face} className={attention ? "text-amber-700" : undefined}>
              {FACE_STATUS_TEXT[face]}
            </span>
          ) : null}
        </span>
        <button type="button" className="rounded p-0.5 hover:bg-muted hover:text-foreground" onClick={() => setSmall((s) => !s)} aria-label={small ? "Show camera preview" : "Hide camera preview"} aria-pressed={small}>
          {small ? <Video className="size-3.5" aria-hidden /> : <Minimize2 className="size-3.5" aria-hidden />}
        </button>
      </div>
      {/* Hidden, not removed: the camera stays on either way. */}
      <CameraPreview stream={stream} className={small ? "hidden" : "block h-27 w-36"} />
    </div>
  );
}
