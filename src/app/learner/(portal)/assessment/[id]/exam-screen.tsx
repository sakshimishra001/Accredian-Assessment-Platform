"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Bookmark, Calculator as CalculatorIcon, ChevronLeft, ChevronRight, Clock, CloudCheck, CloudOff, Eraser, Eye, Loader2, Lock, PauseCircle, Send } from "lucide-react";
import { cn } from "cn";
import { Calculator } from "@/components/exam/calculator";
import { Logo } from "@/components/proto/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AnswerText } from "./answer-text";
import { attemptRuleText, type SectionAttemptRule } from "@/lib/papers/rules";
import { QUESTION_TYPES, hasOptions } from "@/lib/questions/types";
import { formatTime } from "@/prototype/lib/format";
import { useToast } from "@/prototype/toast";
import { cameraLossType, createCameraMonitor, type CameraEventType } from "@/lib/proctoring/camera-monitor";
import { createClipboardMonitor, type ClipboardEventType } from "@/lib/proctoring/clipboard-monitor";
import { expectedInteractions } from "@/lib/proctoring/expected-interactions";
import { createFaceMonitor, type FaceReport, type FaceStatus } from "@/lib/proctoring/face-monitor";
import { createFocusMonitor } from "@/lib/proctoring/focus-monitor";
import { createDepartureTracker, createFullscreenMonitor, type FullscreenState } from "@/lib/proctoring/fullscreen-monitor";
import { attemptClockAction, recordProctoringEventAction, reportFocusLossAction, saveResponsesAction, submitAttemptAction } from "@/server/actions/attempts";
import type { AttemptView, ExamGroup, ExamQuestion } from "@/server/services/attempts";
import { AnswerFiles, QuestionMaterials, type AnswerFile } from "./answer-files";
import { CameraGate, cameraPermission, CameraPip, liveCameraStream, stopCamera, useCameraLease } from "./camera";
import { startFaceSampling } from "./face-detector";
import { enterFullscreen, FULLSCREEN_DENIED, FULLSCREEN_UNSUPPORTED, FullscreenGate, isFullscreen, leaveFullscreen, useFullscreenSupported } from "./fullscreen";

/** Changed answers are saved this long after the last edit (and immediately when moving between questions). */
const AUTOSAVE_DELAY_MS = 2_000;
/** After a failed save, try again this often while there are unsaved answers. */
const RETRY_MS = 10_000;
/** How often the screen asks the server for the attempt's clock (pause / resume, time left). */
const CLOCK_POLL_MS = 15_000;
const CLOCK_POLL_PAUSED_MS = 5_000;
/** The server refuses changes while an administrator has paused the assessment. */
const PAUSED_ERROR = /paused/i;
/** The administrator ended this attempt (the server's message; never the reason). */
const TERMINATED_ERROR = /terminated by the administrator/i;
/** Focus monitoring locked the attempt (the server's message). */
const LOCKED_ERROR = /has been locked/i;

interface Item {
  q: ExamQuestion;
  group?: ExamGroup;
  sectionId: string;
}
interface Draft {
  selected: string[];
  text: string;
  marked: boolean;
}
type SaveState = { kind: "saved"; at: Date | null } | { kind: "saving" } | { kind: "pending" } | { kind: "error"; message: string };

const EMPTY: Draft = { selected: [], text: "", marked: false };
const isAnswered = (q: ExamQuestion, d: Draft | undefined, files = 0) => files > 0 || (!!d && (hasOptions(q.type) ? d.selected.length > 0 : d.text.trim() !== ""));

/**
 * The exam: questions, navigation, autosave and the countdown. The attempt, the saved answers and
 * the deadline all come from the server; this screen only holds unsaved edits until they are saved.
 */
export function ExamScreen({ view }: { view: AttemptView }) {
  const router = useRouter();
  const toast = useToast();
  const { attempt, assessment, sections } = view;

  const items = useMemo<Item[]>(
    () =>
      sections.flatMap((s) =>
        s.items.flatMap((it): Item[] => (it.kind === "group" ? it.children.map((c) => ({ q: c, group: it, sectionId: s.id })) : [{ q: it, sectionId: s.id }])),
      ),
    [sections],
  );

  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(view.responses.map((r) => [r.assessmentQuestionId, { selected: r.selectedOptionIds, text: r.textAnswer ?? "", marked: r.markedForReview }])),
  );
  // Uploaded answer files per question (saved on the server as soon as they are uploaded).
  const [files, setFiles] = useState<Record<string, AnswerFile[]>>(() => Object.fromEntries(view.responses.map((r) => [r.assessmentQuestionId, r.attachments])));
  const fileCount = (id: string) => files[id]?.length ?? 0;
  // Per-question sequence numbers continue from the server's, so a delayed save never overwrites a newer one.
  const seq = useRef<Record<string, number>>(Object.fromEntries(view.responses.map((r) => [r.assessmentQuestionId, r.clientSeq])));
  const dirty = useRef<Set<string>>(new Set());
  const draftsRef = useRef(drafts);
  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);
  const inFlight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closing = useRef(false);

  const [index, setIndex] = useState(0);
  const [visited, setVisited] = useState<Set<string>>(() => new Set(items[0] ? [items[0].q.assessmentQuestionId] : []));
  const [saveState, setSaveState] = useState<SaveState>({ kind: "saved", at: view.responses.length ? new Date(Math.max(...view.responses.map((r) => new Date(r.updatedAt).getTime()))) : null });
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Countdown: anchored to the server's remaining time and re-synced on every save and clock poll.
  // The server enforces the deadline; this is only the display. While the administrator has paused
  // the assessment the countdown stands still (deadline.current = null).
  const deadline = useRef<number | null>(null);
  const [remaining, setRemaining] = useState(attempt.remainingSeconds);
  const [paused, setPaused] = useState(attempt.paused);
  const [terminated, setTerminated] = useState<false | "admin" | "focus">(false);
  const [locked, setLocked] = useState(attempt.locked);
  const lockedRef = useRef(attempt.locked);
  const [focusViolations, setFocusViolations] = useState(attempt.focusViolations);
  const [focusWarning, setFocusWarning] = useState<{ violations: number; max: number } | null>(null);
  // Fullscreen enforcement: "in", "out" (required, e.g. after a reload or resume) or "exited" (just left).
  const [fullscreen, setFullscreen] = useState<FullscreenState>(() => (assessment.fullscreen && !isFullscreen() ? "out" : "in"));
  const fullscreenOk = useFullscreenSupported();
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  /** One incident per departure, shared by focus monitoring, fullscreen and the camera (one exit → one violation). */
  const departures = useRef(createDepartureTracker(() => crypto.randomUUID())).current;
  // Camera required: the stream the pre-exam check opened (same page), or none after a reload — then
  // the learner passes the camera check again before the questions are shown. Never recorded or sent.
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(() => (assessment.camera ? liveCameraStream() : null));
  /** The camera just stopped during the exam (rather than being required again after a reload). */
  const [cameraLost, setCameraLost] = useState(false);
  const cameraMonitor = useRef<ReturnType<typeof createCameraMonitor> | null>(null);
  useCameraLease(!!assessment.camera);
  // Face detection (with the camera): what the in-browser check currently sees, shown under the preview.
  const faceDetection = assessment.camera?.faceDetection ?? null;
  const [faceStatus, setFaceStatus] = useState<FaceStatus | null>(faceDetection ? "starting" : null);
  const faceMonitor = useRef<ReturnType<typeof createFaceMonitor> | null>(null);
  // Learner tool: opening or closing it doesn't touch answers, autosave, the timer or navigation.
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const pausedRef = useRef(attempt.paused);
  useEffect(() => {
    deadline.current = attempt.paused ? null : Date.now() + attempt.remainingSeconds * 1000;
    const t = setInterval(() => {
      if (deadline.current !== null) setRemaining(Math.max(0, Math.round((deadline.current - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(t);
  }, [attempt.remainingSeconds, attempt.paused]);

  /** The attempt was terminated (by an administrator or by focus monitoring): stop everything. */
  function enterTerminated(by: "admin" | "focus" = "admin") {
    closing.current = true;
    deadline.current = null;
    if (timer.current) clearTimeout(timer.current);
    dirty.current.clear();
    setConfirmSubmit(false);
    setFocusWarning(null);
    setTerminated(by);
    leaveFullscreen();
    stopCamera();
  }

  /** Focus monitoring locked the attempt: nothing more can be changed or submitted (the timer runs on). */
  function enterLocked() {
    lockedRef.current = true;
    if (timer.current) clearTimeout(timer.current);
    dirty.current.clear();
    setConfirmSubmit(false);
    setFocusWarning(null);
    setLocked(true);
    leaveFullscreen();
    stopCamera();
  }

  /** Freeze the countdown at the server's remaining time (the assessment was paused). */
  function enterPause(remainingSeconds?: number) {
    pausedRef.current = true;
    deadline.current = null;
    if (remainingSeconds !== undefined) setRemaining(remainingSeconds);
    setPaused(true);
  }

  /** The unsaved answers, in the shape the attempt service expects. */
  function pending() {
    return [...dirty.current].map((id) => {
      const d = draftsRef.current[id] ?? EMPTY;
      return { assessmentQuestionId: id, selectedOptionIds: d.selected, textAnswer: d.text, markedForReview: d.marked, clientSeq: seq.current[id] };
    });
  }

  /** The attempt was closed on the server (submitted elsewhere or time up): show the outcome. */
  function closed(message: string) {
    if (closing.current) return;
    closing.current = true;
    stopCamera();
    toast.info("Your attempt is closed", message);
    router.refresh();
  }

  /** Save every changed answer. One request at a time; edits made meanwhile are saved right after. */
  async function flush(): Promise<boolean> {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inFlight.current) await inFlight.current;
    const batch = pending();
    if (batch.length === 0 || closing.current) return true;
    let ok = false;
    const run = (async () => {
      setSaveState({ kind: "saving" });
      try {
        const result = await saveResponsesAction(attempt.id, batch);
        if (result.ok) {
          // Only clear what was sent and hasn't changed since.
          for (const r of batch) if (seq.current[r.assessmentQuestionId] === r.clientSeq) dirty.current.delete(r.assessmentQuestionId);
          deadline.current = Date.now() + result.data!.remainingSeconds * 1000;
          setSaveState(dirty.current.size ? { kind: "pending" } : { kind: "saved", at: new Date(result.data!.savedAt) });
          ok = true;
        } else if (TERMINATED_ERROR.test(result.error)) {
          enterTerminated();
        } else if (LOCKED_ERROR.test(result.error)) {
          enterLocked();
        } else if (/already been submitted|Time is up/.test(result.error)) {
          closed(result.error);
        } else if (PAUSED_ERROR.test(result.error)) {
          // Kept as unsaved; saved as soon as the assessment resumes.
          enterPause();
          setSaveState({ kind: "pending" });
        } else {
          setSaveState({ kind: "error", message: result.error });
        }
      } catch {
        setSaveState({ kind: "error", message: "No connection — your latest answers aren’t saved yet. Retrying…" });
      }
    })();
    inFlight.current = run;
    await run;
    inFlight.current = null;
    if (dirty.current.size && !closing.current && !pausedRef.current) timer.current = setTimeout(() => void flush(), ok ? AUTOSAVE_DELAY_MS : RETRY_MS);
    return ok;
  }

  // The attempt's clock from the server: picks up a pause or resume by the administrator (and a
  // closed attempt) without a reload, and keeps the countdown aligned with the server.
  useEffect(() => {
    let stopped = false;
    let t: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await attemptClockAction(attempt.id);
        if (stopped || closing.current) return;
        if (result.ok) {
          const clock = result.data!;
          if (clock.status === "TERMINATED") return enterTerminated(clock.terminatedByFocus ? "focus" : "admin");
          if (clock.locked && !lockedRef.current) enterLocked();
          if (clock.status !== "IN_PROGRESS") return closed("Your attempt has been submitted.");
          if (clock.paused) enterPause(clock.remainingSeconds);
          else {
            const resumed = pausedRef.current;
            pausedRef.current = false;
            deadline.current = Date.now() + clock.remainingSeconds * 1000;
            setRemaining(clock.remainingSeconds);
            setPaused(false);
            if (resumed && dirty.current.size) void flush();
          }
        }
      } catch {
        // Offline for a moment: the next poll (or save) catches up.
      }
      if (!stopped) t = setTimeout(poll, pausedRef.current ? CLOCK_POLL_PAUSED_MS : CLOCK_POLL_MS);
    }
    t = setTimeout(poll, pausedRef.current ? CLOCK_POLL_PAUSED_MS : CLOCK_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one poller per attempt
  }, [attempt.id]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  // Warn before leaving the page with unsaved answers.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty.current.size) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const edit = (id: string, patch: Partial<Draft>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY), ...patch } }));
    seq.current[id] = (seq.current[id] ?? 0) + 1;
    dirty.current.add(id);
    setSaveState({ kind: "pending" });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
  };

  const goTo = (i: number) => {
    if (i < 0 || i >= items.length) return;
    setIndex(i);
    setVisited((v) => new Set(v).add(items[i].q.assessmentQuestionId));
    if (dirty.current.size) void flush();
  };

  async function submit(auto = false) {
    if (submitting || closing.current) return;
    setSubmitting(true);
    if (timer.current) clearTimeout(timer.current);
    if (inFlight.current) await inFlight.current;
    try {
      const result = await submitAttemptAction(attempt.id, pending());
      if (!result.ok) {
        setSubmitting(false);
        if (TERMINATED_ERROR.test(result.error)) {
          enterTerminated();
          return;
        }
        if (LOCKED_ERROR.test(result.error)) {
          enterLocked();
          return;
        }
        if (PAUSED_ERROR.test(result.error)) {
          setConfirmSubmit(false);
          enterPause();
          return;
        }
        toast.error("Couldn’t submit", result.error);
        return;
      }
      dirty.current.clear();
      closing.current = true;
      setConfirmSubmit(false);
      leaveFullscreen();
      stopCamera();
      if (result.data!.lateAnswersIgnored || auto) toast.info("Time is up", "Your saved answers were submitted automatically.");
      else toast.success("Assessment submitted", `${result.data!.savedResponses} answers saved.`);
      router.refresh();
    } catch {
      setSubmitting(false);
      toast.error("Couldn’t submit", "Check your connection and try again. Your saved answers are safe.");
    }
  }

  // Focus monitoring: the browser only reports that the learner left the exam (one incident per
  // departure — a hidden tab and a lost window focus from the same departure count once); the
  // server keeps the count and applies the limit. Nothing is reported while paused, locked or closed,
  // nor for the exam's own frames and announced native dialogs (file picker, downloads, camera
  // prompt) — see lib/proctoring/focus-monitor.ts.
  useEffect(() => {
    if (!assessment.focusMonitoring) return;

    async function report(incidentId: string) {
      try {
        const result = await reportFocusLossAction(attempt.id, incidentId);
        if (!result.ok) {
          if (TERMINATED_ERROR.test(result.error)) enterTerminated();
          else if (/already been submitted|Time is up/.test(result.error)) closed(result.error);
          return;
        }
        const r = result.data!;
        setFocusViolations(r.violations);
        if (r.outcome === "TERMINATED") enterTerminated("focus");
        else if (r.outcome === "LOCKED") enterLocked();
        else if (r.outcome === "WARNING" && r.recorded) setFocusWarning({ violations: r.violations, max: r.maxViolations });
      } catch {
        // Offline: the incident isn't counted (browser-based monitoring has limits).
      }
    }
    const monitor = createFocusMonitor({
      isIdle: () => closing.current || pausedRef.current || lockedRef.current,
      hasFocus: () => document.hasFocus(),
      focusInFrame: () => document.activeElement?.tagName === "IFRAME",
      isVisible: () => document.visibilityState === "visible",
      expected: expectedInteractions,
      onLeave: () => void report(departures.leave("focus")),
      onBack: () => departures.back("focus"),
    });
    const onVisibility = () => monitor.visibilityChange();
    const onBlur = () => monitor.blur();
    const onFocus = () => monitor.focus();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      monitor.dispose();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one monitor per attempt
  }, [attempt.id, assessment.focusMonitoring]);

  // Fullscreen enforcement: the browser says whether the exam is in fullscreen; an exit is reported
  // once (however many events the browser fires for it) and the server decides whether it counts.
  // Nothing is reported while paused, locked or closing — after a resume the learner is just asked
  // to return. Exits share the departure with focus monitoring, so one Alt+Tab counts once.
  useEffect(() => {
    if (!assessment.fullscreen) return;
    async function report(incidentId: string) {
      try {
        const result = await recordProctoringEventAction(attempt.id, { eventType: "FULLSCREEN_EXIT", incidentId });
        if (!result.ok) {
          if (TERMINATED_ERROR.test(result.error)) enterTerminated();
          else if (LOCKED_ERROR.test(result.error)) enterLocked();
          else if (/already been submitted|Time is up/.test(result.error)) closed(result.error);
          return;
        }
        const r = result.data!;
        setFocusViolations(r.violations);
        if (r.outcome === "TERMINATED") enterTerminated("focus");
        else if (r.outcome === "LOCKED") enterLocked();
      } catch {
        // Offline: the exit isn't counted (browser-based monitoring has limits); the gate still shows.
      }
    }
    const monitor = createFullscreenMonitor({
      isFullscreen,
      isIdle: () => closing.current || pausedRef.current || lockedRef.current,
      // Browsers may leave fullscreen to show a native dialog the exam opened (e.g. the file picker).
      isExpected: () => expectedInteractions.covers("fullscreen"),
      onExit: () => void report(departures.leave("fullscreen")),
    });
    const onChange = () => {
      const state = monitor.sync();
      if (state === "in") {
        departures.back("fullscreen");
        setFullscreenError(null);
      }
      setFullscreen(state);
    };
    onChange();
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one monitor per attempt
  }, [attempt.id, assessment.fullscreen]);

  // Clipboard monitoring: copy / cut / paste in the exam are reported — only that they happened, never
  // what was copied or pasted (clipboard data is not read) — and are not blocked, so typing and
  // answering work as normal. Each operation is its own event; independent of focus and fullscreen.
  // Nothing is reported while paused, locked or closing.
  useEffect(() => {
    if (!assessment.clipboardMonitoring) return;
    async function report(eventType: ClipboardEventType) {
      try {
        const result = await recordProctoringEventAction(attempt.id, { eventType, incidentId: crypto.randomUUID() });
        if (!result.ok) {
          if (TERMINATED_ERROR.test(result.error)) enterTerminated();
          else if (LOCKED_ERROR.test(result.error)) enterLocked();
          else if (/already been submitted|Time is up/.test(result.error)) closed(result.error);
          return;
        }
        const r = result.data!;
        setFocusViolations(r.violations);
        if (r.outcome === "TERMINATED") enterTerminated("focus");
        else if (r.outcome === "LOCKED") enterLocked();
        else if (r.recorded) toast.info("Clipboard activity recorded", `Copy, cut and paste are monitored in this assessment. Violation ${r.violations} of ${r.maxViolations}.`);
      } catch {
        // Offline: the operation isn't counted (browser-based monitoring has limits).
      }
    }
    const monitor = createClipboardMonitor({ isIdle: () => closing.current || pausedRef.current || lockedRef.current, report: (t) => void report(t) });
    const handlers = { copy: (e: Event) => monitor.handle("copy", e), cut: (e: Event) => monitor.handle("cut", e), paste: (e: Event) => monitor.handle("paste", e) };
    for (const [kind, handler] of Object.entries(handlers)) document.addEventListener(kind, handler, true);
    return () => {
      for (const [kind, handler] of Object.entries(handlers)) document.removeEventListener(kind, handler, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one monitor per attempt
  }, [attempt.id, assessment.clipboardMonitoring]);

  // Camera (proctoring with "Require camera"): the browser says when the camera stops — the track
  // ends (unplugged, turned off, taken by the system) or the permission is revoked. A loss is reported
  // once and the server decides whether it counts; the questions stay hidden until the learner passes
  // the camera check again. Nothing is reported while paused, locked or closing. Losses share the
  // departure with focus and fullscreen, so leaving fullscreen to re-allow the camera counts once.
  async function reportCamera(eventType: CameraEventType, incidentId: string) {
    try {
      const result = await recordProctoringEventAction(attempt.id, { eventType, incidentId });
      if (!result.ok) {
        if (TERMINATED_ERROR.test(result.error)) enterTerminated();
        else if (LOCKED_ERROR.test(result.error)) enterLocked();
        else if (/already been submitted|Time is up/.test(result.error)) closed(result.error);
        return;
      }
      const r = result.data!;
      setFocusViolations(r.violations);
      if (r.outcome === "TERMINATED") enterTerminated("focus");
      else if (r.outcome === "LOCKED") enterLocked();
    } catch {
      // Offline: the loss isn't counted (browser-based monitoring has limits); the gate still shows.
    }
  }

  useEffect(() => {
    if (!assessment.camera || !cameraStream) return;
    const monitor = (cameraMonitor.current ??= createCameraMonitor({
      isIdle: () => closing.current || pausedRef.current || lockedRef.current,
      onLoss: (type) => void reportCamera(type, departures.leave("camera")),
    }));
    monitor.ready();
    departures.back("camera");
    let done = false;
    let endedTimer: ReturnType<typeof setTimeout> | null = null;
    let permission: PermissionStatus | null = null;
    function lose(type: CameraEventType) {
      if (done) return;
      done = true;
      stopCamera();
      setCameraLost(true);
      setCameraStream(null);
      monitor.lost(type);
    }
    // A revoked permission also ends the track: give the permission change a moment to arrive first.
    const onEnded = () => {
      endedTimer ??= setTimeout(async () => lose(cameraLossType(await cameraPermission())), 300);
    };
    const tracks = cameraStream.getVideoTracks();
    for (const t of tracks) t.addEventListener("ended", onEnded);
    if (!tracks.some((t) => t.readyState === "live")) onEnded();
    navigator.permissions
      ?.query({ name: "camera" as PermissionName })
      .then((status) => {
        if (done) return;
        permission = status;
        status.onchange = () => {
          if (status.state !== "granted") lose("CAMERA_PERMISSION_REVOKED");
        };
      })
      .catch(() => {});
    return () => {
      done = true;
      if (endedTimer) clearTimeout(endedTimer);
      for (const t of tracks) t.removeEventListener("ended", onEnded);
      if (permission) permission.onchange = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one watcher per camera stream
  }, [attempt.id, assessment.camera, cameraStream]);

  // Face detection: runs in this browser on the existing camera stream (no second stream, nothing
  // sent but the event itself). A sustained missing face or a second person is reported once per
  // episode; the server decides whether it counts and applies the action. Silent while paused,
  // locked or closing, while the page is hidden and while the camera gate is up (no stream). A
  // detector failure only shows "Face check unavailable" — never a violation; camera-loss monitoring
  // is unaffected. A missing face shares the departure with focus / fullscreen / camera.
  async function reportFace(r: FaceReport) {
    try {
      const result = await recordProctoringEventAction(attempt.id, { eventType: r.eventType, incidentId: r.incidentId, durationMs: Math.round(r.durationMs), metadata: { faces: r.faces } });
      if (!result.ok) {
        if (TERMINATED_ERROR.test(result.error)) enterTerminated();
        else if (LOCKED_ERROR.test(result.error)) enterLocked();
        else if (/already been submitted|Time is up/.test(result.error)) closed(result.error);
        return;
      }
      const o = result.data!;
      setFocusViolations(o.violations);
      if (o.outcome === "TERMINATED") enterTerminated("focus");
      else if (o.outcome === "LOCKED") enterLocked();
      else if (o.recorded) {
        toast.info(
          "Proctoring violation recorded",
          `${r.eventType === "FACE_NOT_DETECTED" ? "Your face wasn’t visible to the camera for a while." : "More than one person was visible to the camera."} Violation ${o.violations} of ${o.maxViolations}.`,
        );
      }
    } catch {
      // Offline: the episode isn't counted (browser-based monitoring has limits).
    }
  }

  useEffect(() => {
    if (!faceDetection || !cameraStream) return;
    const idle = () => closing.current || pausedRef.current || lockedRef.current;
    const monitor = (faceMonitor.current ??= createFaceMonitor({
      isIdle: idle,
      events: faceDetection,
      departures,
      newId: () => crypto.randomUUID(),
      report: (r) => void reportFace(r),
    }));
    const stop = startFaceSampling(cameraStream, {
      shouldSample: () => document.visibilityState === "visible" && !idle(),
      onIdle: () => setFaceStatus(monitor.reset()),
      onSample: (now, sample) => setFaceStatus(monitor.sample(now, sample)),
      onUnavailable: () => setFaceStatus(monitor.unavailable()),
    });
    return () => {
      stop();
      setFaceStatus(monitor.reset());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one detector loop per camera stream
  }, [attempt.id, faceDetection?.missing, faceDetection?.multiple, cameraStream]);

  async function returnToFullscreen() {
    setFullscreenError(null);
    const r = await enterFullscreen();
    if (r !== "ok") setFullscreenError(r === "unsupported" ? FULLSCREEN_UNSUPPORTED : FULLSCREEN_DENIED);
  }

  // Time up: hand everything to the server, which closes the attempt with what was saved in time.
  useEffect(() => {
    if (deadline.current !== null && remaining === 0 && !closing.current && !pausedRef.current) void submit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once when the countdown reaches zero
  }, [remaining]);

  const current = items[index];
  if (!current) {
    return <p className="p-8 text-center text-sm text-muted-foreground">This assessment has no questions.</p>;
  }
  const id = current.q.assessmentQuestionId;
  const d = drafts[id] ?? EMPTY;
  const section = sections.find((s) => s.id === current.sectionId)!;
  const multi = current.q.type === "MCQ_MULTI";
  const answeredCount = items.filter((it) => isAnswered(it.q, drafts[it.q.assessmentQuestionId], fileCount(it.q.assessmentQuestionId))).length;
  const missingFiles = items.filter((it) => it.q.response?.fileRequired && it.q.response.type !== "TEXT" && fileCount(it.q.assessmentQuestionId) === 0);
  const markedCount = items.filter((it) => drafts[it.q.assessmentQuestionId]?.marked).length;
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");
  const lowTime = remaining < 5 * 60;
  // The camera check comes first (its permission prompt is easier outside fullscreen), then fullscreen.
  const cameraGate = !!assessment.camera && !cameraStream && !terminated && !paused && !locked;

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      {terminated ? (
        <TerminatedScreen assessmentId={view.assessment.id} byFocus={terminated === "focus"} />
      ) : paused ? (
        <PausedScreen remaining={`${mm}:${ss}`} allSaved={!dirty.current.size} />
      ) : locked ? (
        <LockedScreen assessmentId={view.assessment.id} />
      ) : null}
      {assessment.camera && cameraGate ? (
        <CameraGate
          lost={cameraLost}
          violations={focusViolations}
          maxViolations={assessment.camera.maxViolations}
          action={assessment.camera.action}
          onReturn={(stream) => {
            setCameraLost(false);
            setCameraStream(stream);
          }}
        />
      ) : null}
      {assessment.fullscreen && fullscreen !== "in" && !terminated && !paused && !locked && !cameraGate ? (
        <FullscreenGate
          exited={fullscreen === "exited"}
          supported={fullscreenOk}
          violations={focusViolations}
          maxViolations={assessment.fullscreen.maxViolations}
          action={assessment.fullscreen.action}
          error={fullscreenError}
          onReturn={() => void returnToFullscreen()}
        />
      ) : null}
      {focusWarning && !terminated && !locked && !cameraGate && !(assessment.fullscreen && fullscreen !== "in") ? (
        <FocusWarning violations={focusWarning.violations} max={focusWarning.max} action={assessment.focusMonitoring?.action ?? "TERMINATE"} onClose={() => setFocusWarning(null)} />
      ) : null}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background px-4 md:px-6">
        <span className="hidden sm:block">
          <Logo collapsed />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{assessment.name}</p>
          <SaveIndicator state={saveState} attemptNumber={attempt.attemptNumber} />
        </div>
        <div
          className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-sm font-semibold tabular-nums", lowTime ? "bg-red-50 text-red-700" : "bg-muted")}
          role="timer"
          aria-label={`Time remaining ${mm} minutes ${ss} seconds`}
        >
          <Clock className="size-4" /> {mm}:{ss}
        </div>
        {assessment.focusMonitoring ? (
          <span
            className={cn("hidden items-center gap-1 rounded-md px-2 py-1 text-xs font-medium md:inline-flex", focusViolations ? "bg-amber-50 text-amber-800" : "bg-muted text-muted-foreground")}
            title="Focus monitoring is on: leaving this tab or window counts as a violation."
          >
            <Eye className="size-3.5" aria-hidden /> Focus {focusViolations}/{assessment.focusMonitoring.maxViolations}
          </span>
        ) : null}
        {assessment.calculator ? (
          <div className="flex items-center gap-1" role="group" aria-label="Tools">
            <span className="hidden text-xs text-muted-foreground lg:inline">Tools</span>
            <Button variant="outline" size="sm" onClick={() => setCalculatorOpen((o) => !o)} aria-pressed={calculatorOpen} aria-label={calculatorOpen ? "Close calculator" : "Open calculator"}>
              <CalculatorIcon /> <span className="hidden sm:inline">Calculator</span>
            </Button>
          </div>
        ) : null}
        <Button onClick={() => setConfirmSubmit(true)} disabled={submitting || paused}>
          <Send /> Submit
        </Button>
      </header>
      {assessment.camera && cameraStream && !terminated && !locked ? <CameraPip stream={cameraStream} face={faceStatus} /> : null}
      {assessment.calculator && calculatorOpen && !paused && !terminated ? <Calculator kind={assessment.calculator} onClose={() => setCalculatorOpen(false)} /> : null}

      <div className={cn("mx-auto grid w-full max-w-7xl flex-1 gap-4 p-4", assessment.showQuestionPalette && "lg:grid-cols-[1fr_18rem]")}>
        <main className="min-w-0 self-start rounded-lg border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
            <div>
              <p className="text-sm font-semibold">{section.title}</p>
              <p className="text-xs text-muted-foreground">{attemptRuleText(section.attemptRule as SectionAttemptRule, section.attemptCount, section.items.length)}</p>
            </div>
            <span className="text-xs text-muted-foreground">
              Question {index + 1} of {items.length}
            </span>
          </div>
          <div className="grid gap-4 p-5">
            {section.instructions && items.findIndex((it) => it.sectionId === section.id) === index ? (
              <p className="rounded-md border-l-2 border-primary bg-accent/40 px-3 py-2 text-sm">{section.instructions}</p>
            ) : null}
            {current.group ? (
              <div className="max-h-64 overflow-auto rounded-lg border bg-muted/40 px-4 py-3 text-sm leading-relaxed">
                <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {current.group.groupType === "CASE_STUDY" ? "Case" : "Passage"} · Q{current.group.number}
                </p>
                <p className="font-medium">{current.group.text}</p>
                {current.group.passage ? <p className="mt-1 whitespace-pre-line">{current.group.passage}</p> : null}
              </div>
            ) : null}
            <div className="flex items-start justify-between gap-3">
              <p className="text-base leading-relaxed whitespace-pre-line">
                <span className="mr-2 font-semibold">Q{current.q.number}.</span>
                {current.q.text}
              </p>
              <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {current.q.marks} mark{current.q.marks === 1 ? "" : "s"}
                {current.q.negativeMarks ? ` · −${current.q.negativeMarks} if wrong` : ""}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {QUESTION_TYPES[current.q.type].label}
              {multi ? " — select all that apply" : ""}
            </p>
            <QuestionMaterials materials={[...(current.group?.materials ?? []), ...current.q.materials]} />
            {hasOptions(current.q.type) ? (
              <ul className="grid gap-2" role={multi ? "group" : "radiogroup"} aria-label={`Options for question ${current.q.number}`}>
                {current.q.options.map((o, i) => {
                  const checked = d.selected.includes(o.id);
                  return (
                    <li key={o.id}>
                      <button
                        type="button"
                        role={multi ? "checkbox" : "radio"}
                        aria-checked={checked}
                        onClick={() => edit(id, { selected: multi ? (checked ? d.selected.filter((x) => x !== o.id) : [...d.selected, o.id]) : [o.id] })}
                        className={cn("flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors", checked ? "border-primary bg-accent/60 ring-1 ring-primary" : "hover:bg-muted/60")}
                      >
                        <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium", multi && "rounded-md", checked && "border-primary bg-primary text-primary-foreground")}>
                          {String.fromCharCode(65 + i)}
                        </span>
                        {o.text}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : current.q.response?.type === "FILE" ? null : (
              <div>
                <p className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Your answer</p>
                <AnswerText
                  spellCheck={assessment.spellCheck}
                  rows={current.q.type === "LONG_ANSWER" ? 12 : 5}
                  value={d.text}
                  onChange={(e) => edit(id, { text: e.target.value })}
                  placeholder="Type your answer…"
                  aria-label={`Answer for question ${current.q.number}`}
                />
                <p className="mt-1 text-right text-xs text-muted-foreground">{d.text.trim() ? d.text.trim().split(/\s+/).length : 0} words</p>
              </div>
            )}
            {current.q.response && current.q.response.type !== "TEXT" ? (
              <AnswerFiles
                key={id}
                attemptId={attempt.id}
                assessmentQuestionId={id}
                questionLabel={`question ${current.q.number}`}
                config={current.q.response}
                files={files[id] ?? []}
                onChange={(list) => setFiles((m) => ({ ...m, [id]: list }))}
                onClosed={closed}
              />
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3">
            <div className="flex gap-2">
              {assessment.allowMarkForReview ? (
                <Button variant="outline" onClick={() => edit(id, { marked: !d.marked })} aria-pressed={d.marked}>
                  <Bookmark className={cn(d.marked && "fill-current")} /> {d.marked ? "Unmark review" : "Mark for review"}
                </Button>
              ) : null}
              <Button variant="ghost" disabled={!d.selected.length && !d.text} onClick={() => edit(id, { selected: [], text: "" })}>
                <Eraser /> Clear response
              </Button>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" disabled={index === 0} onClick={() => goTo(index - 1)}>
                <ChevronLeft /> Previous
              </Button>
              {index < items.length - 1 ? (
                <Button onClick={() => goTo(index + 1)}>
                  Save & Next <ChevronRight />
                </Button>
              ) : (
                <Button onClick={() => setConfirmSubmit(true)} disabled={submitting}>
                  <Send /> Finish
                </Button>
              )}
            </div>
          </div>
        </main>

        {assessment.showQuestionPalette ? (
          <aside className="rounded-lg border bg-card p-4 lg:sticky lg:top-18 lg:self-start" aria-label="Question navigation">
            <p className="text-sm font-semibold">Question navigation</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {answeredCount} answered · {items.length - answeredCount} remaining{markedCount ? ` · ${markedCount} marked` : ""}
            </p>
            <div className="mt-3 grid max-h-[55vh] gap-3 overflow-auto">
              {sections.map((s) => {
                const sItems = items.map((it, i) => ({ it, i })).filter(({ it }) => it.sectionId === s.id);
                return (
                  <div key={s.id}>
                    <button type="button" className="mb-1.5 text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground" onClick={() => goTo(sItems[0]?.i ?? 0)}>
                      {s.title}
                    </button>
                    <div className="grid grid-cols-6 gap-1.5">
                      {sItems.map(({ it, i }) => {
                        const qid = it.q.assessmentQuestionId;
                        const answered = isAnswered(it.q, drafts[qid], fileCount(qid));
                        const isMarked = !!drafts[qid]?.marked;
                        const seen = visited.has(qid);
                        return (
                          <button
                            key={qid}
                            type="button"
                            onClick={() => goTo(i)}
                            aria-label={`Question ${it.q.number}${answered ? ", answered" : ""}${isMarked ? ", marked for review" : ""}`}
                            aria-current={i === index ? "true" : undefined}
                            className={cn(
                              "relative h-8 rounded-md border text-[11px] font-medium tabular-nums",
                              answered ? "border-emerald-600 bg-emerald-600 text-white" : seen ? "border-amber-300 bg-amber-50 text-amber-900" : "bg-background text-muted-foreground",
                              isMarked && "ring-2 ring-violet-500 ring-offset-1",
                              i === index && "outline-2 outline-offset-2 outline-primary",
                            )}
                          >
                            {it.q.number}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <ul className="mt-4 grid gap-1.5 border-t pt-3 text-xs text-muted-foreground">
              <li className="flex items-center gap-2"><span className="size-3 rounded-sm bg-emerald-600" /> Answered</li>
              <li className="flex items-center gap-2"><span className="size-3 rounded-sm border border-amber-300 bg-amber-50" /> Visited, not answered</li>
              <li className="flex items-center gap-2"><span className="size-3 rounded-sm border" /> Not visited</li>
              <li className="flex items-center gap-2"><span className="size-3 rounded-sm ring-2 ring-violet-500" /> Marked for review</li>
            </ul>
          </aside>
        ) : null}
      </div>

      <Dialog open={confirmSubmit} onOpenChange={(o) => !submitting && setConfirmSubmit(o)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Submit assessment?</DialogTitle>
            <DialogDescription>
              You have answered {answeredCount} of {items.length} questions{markedCount ? ` and marked ${markedCount} for review` : ""}. You can’t change your answers after submitting.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-64 overflow-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Question</th>
                  <th className="px-3 py-1.5 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const qd = drafts[it.q.assessmentQuestionId];
                  const answered = isAnswered(it.q, qd, fileCount(it.q.assessmentQuestionId));
                  return (
                    <tr key={it.q.assessmentQuestionId} className="border-t">
                      <td className="px-3 py-1.5 font-medium tabular-nums">
                        <button
                          type="button"
                          className="hover:underline"
                          onClick={() => {
                            setConfirmSubmit(false);
                            goTo(i);
                          }}
                        >
                          Q{it.q.number}
                        </button>
                      </td>
                      <td className={cn("px-3 py-1.5", answered ? "text-emerald-700" : "text-muted-foreground")}>
                        {answered ? "Answered" : "Not answered"}
                        {qd?.marked ? <span className="ml-2 text-violet-700">· Marked for review</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {missingFiles.length ? (
            <p className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset" role="alert">
              <AlertTriangle className="size-4 shrink-0" /> Upload the required file for {missingFiles.map((it) => `Q${it.q.number}`).join(", ")} before submitting.
            </p>
          ) : null}
          {saveState.kind === "error" ? (
            <p className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset" role="alert">
              <AlertTriangle className="size-4 shrink-0" /> Some answers aren’t saved yet. Submitting sends them now.
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSubmit(false)} disabled={submitting}>
              Keep working
            </Button>
            <Button onClick={() => void submit()} disabled={submitting || missingFiles.length > 0}>
              {submitting ? "Submitting…" : "Submit assessment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SaveIndicator({ state, attemptNumber }: { state: SaveState; attemptNumber: number }) {
  const suffix = ` · Attempt #${attemptNumber}`;
  if (state.kind === "error") {
    return (
      <p className="flex items-center gap-1 text-xs text-red-700" role="alert">
        <CloudOff className="size-3.5" /> {state.message}
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite" data-save-state={state.kind}>
      {state.kind === "saving" ? (
        <>
          <Loader2 className="size-3.5 animate-spin" /> Saving…
        </>
      ) : state.kind === "pending" ? (
        <>
          <CloudCheck className="size-3.5 text-amber-600" /> Unsaved changes
        </>
      ) : (
        <>
          <CloudCheck className="size-3.5 text-emerald-600" /> {state.at ? `All answers saved · ${formatTime(state.at.toISOString())}` : "Answers save automatically"}
        </>
      )}
      {suffix}
    </p>
  );
}

/**
 * Shown over the whole exam while the administrator has paused the assessment: nothing can be
 * answered, the timer stands still, and the screen continues by itself when the assessment resumes.
 */
function PausedScreen({ remaining, allSaved }: { remaining: string; allSaved: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 px-4 backdrop-blur-sm" role="alertdialog" aria-modal="true" aria-labelledby="paused-title" aria-describedby="paused-body">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-amber-50 text-amber-700">
          <PauseCircle className="size-6" aria-hidden />
        </span>
        <h2 id="paused-title" className="mt-4 text-xl font-semibold tracking-tight">
          Assessment Paused
        </h2>
        <div id="paused-body" className="mt-2 grid gap-2 text-sm text-muted-foreground">
          <p>The administrator has temporarily paused this assessment. Your exam timer is paused.</p>
          <p>{allSaved ? "Your answers have been saved." : "Your latest changes will be saved as soon as the assessment resumes."}</p>
          <p>Please wait — the assessment continues here automatically when it resumes.</p>
        </div>
        <p className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 font-mono text-sm font-semibold tabular-nums" aria-label={`Time remaining ${remaining}`}>
          <Clock className="size-4" aria-hidden /> {remaining} remaining
        </p>
      </div>
    </div>
  );
}

/**
 * Shown over the whole exam once an administrator has terminated the attempt. The attempt can't be
 * continued or submitted; the learner goes back to the assessment page (which shows the outcome).
 */
function TerminatedScreen({ assessmentId, byFocus = false }: { assessmentId: string; byFocus?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 px-4 backdrop-blur-sm" role="alertdialog" aria-modal="true" aria-labelledby="terminated-title" aria-describedby="terminated-body">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-red-50 text-red-600">
          <Ban className="size-6" aria-hidden />
        </span>
        <h2 id="terminated-title" className="mt-4 text-xl font-semibold tracking-tight">
          Assessment Terminated
        </h2>
        <div id="terminated-body" className="mt-2 grid gap-2 text-sm text-muted-foreground">
          <p>{byFocus ? "Your assessment has been terminated because the proctoring violation limit was reached." : "Your assessment has been terminated by the administrator."}</p>
          <p>Your saved responses have been recorded.</p>
          <p>You can no longer continue this attempt.</p>
        </div>
        <Link href={`/learner/assessment/${assessmentId}`} className="mt-6 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          Back to the assessment
        </Link>
      </div>
    </div>
  );
}

/** Shown when the learner comes back after leaving the exam (focus monitoring), with the count. */
function FocusWarning({ violations, max, action, onClose }: { violations: number; max: number; action: "LOCK" | "TERMINATE" | "WARN"; onClose: () => void }) {
  const left = max - violations;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 backdrop-blur-sm" role="alertdialog" aria-modal="true" aria-labelledby="focus-title" aria-describedby="focus-body">
      <div className="w-full max-w-md rounded-xl border bg-card p-7 text-center shadow-sm">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-amber-50 text-amber-700">
          <AlertTriangle className="size-6" aria-hidden />
        </span>
        <h2 id="focus-title" className="mt-4 text-lg font-semibold tracking-tight">
          Focus violation detected
        </h2>
        <div id="focus-body" className="mt-2 grid gap-2 text-sm text-muted-foreground">
          <p>You left the assessment window or tab.</p>
          <p className="font-medium text-foreground">
            Violation {violations} of {max}
          </p>
          <p>
            {action === "WARN"
              ? "Each time you leave the assessment it is recorded for the administrator. Your answers are saved and the timer keeps running."
              : `${left === 1 ? "One more" : `${left} more`} and your exam will be ${action === "LOCK" ? "locked" : "terminated"}. Your answers are saved and the timer keeps running.`}
          </p>
        </div>
        <Button className="mt-5" onClick={onClose} autoFocus>
          Return to the assessment
        </Button>
      </div>
    </div>
  );
}

/** Shown once focus monitoring has locked the attempt: nothing more can be answered or submitted. */
function LockedScreen({ assessmentId }: { assessmentId: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 px-4 backdrop-blur-sm" role="alertdialog" aria-modal="true" aria-labelledby="locked-title" aria-describedby="locked-body">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-amber-50 text-amber-700">
          <Lock className="size-6" aria-hidden />
        </span>
        <h2 id="locked-title" className="mt-4 text-xl font-semibold tracking-tight">
          Exam Locked
        </h2>
        <div id="locked-body" className="mt-2 grid gap-2 text-sm text-muted-foreground">
          <p>Your exam has been locked because the proctoring violation limit was reached.</p>
          <p>Your saved answers are kept. You can no longer change or submit them.</p>
          <p>Please contact your administrator.</p>
        </div>
        <Link href={`/learner/assessment/${assessmentId}`} className="mt-6 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          Back to the assessment
        </Link>
      </div>
    </div>
  );
}
