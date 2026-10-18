"use client";

import type { FaceDetector } from "@mediapipe/tasks-vision";
import { FACE_MODEL_PATH, FACE_WASM_PATH } from "@/lib/proctoring/face-assets";
import { FACE_RULES, type FaceSample } from "@/lib/proctoring/face-monitor";

/*
 * The in-browser face detector (MediaPipe Tasks Vision FaceDetector, BlazeFace short-range), loaded
 * lazily from our own domain only when face detection is switched on. It reads frames from a video
 * element showing the learner's existing camera stream and returns, per frame, each face's
 * confidence and width — nothing else. No frame, image or coordinate leaves this function: nothing
 * is drawn, captured, stored or sent. No face recognition, landmarks or embeddings are used.
 */

/** Below this the detector returns nothing; the face monitor applies the real thresholds (0.6 / 0.7). */
const DETECTOR_MIN_CONFIDENCE = 0.5;

let loading: Promise<FaceDetector> | null = null;
/** MediaPipe needs strictly increasing timestamps per detector (one detector serves the page). */
let lastTimestamp = 0;

/** Load the detector once per page (runtime ~3.6 MB compressed + 230 KB model, then cached by the browser). */
export function loadFaceDetector(): Promise<FaceDetector> {
  loading ??= (async () => {
    const { FaceDetector, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(FACE_WASM_PATH);
    return FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL_PATH, delegate: "CPU" },
      runningMode: "VIDEO",
      minDetectionConfidence: DETECTOR_MIN_CONFIDENCE,
    });
  })();
  // A failed load can be retried (e.g. after a network hiccup before the exam).
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/**
 * Detect faces in the video's current frame. Returns null when there is no frame yet (the video
 * hasn't started); throws if inference fails (the caller treats that as "unavailable").
 */
export function detectFaces(detector: FaceDetector, video: HTMLVideoElement): FaceSample | null {
  if (video.readyState < 2 || !video.videoWidth) return null;
  lastTimestamp = Math.max(performance.now(), lastTimestamp + 1);
  const result = detector.detectForVideo(video, lastTimestamp);
  const frameWidth = video.videoWidth;
  return { faces: result.detections.map((d) => ({ score: d.categories[0]?.score ?? 0, width: (d.boundingBox?.width ?? 0) / frameWidth })) };
}

/**
 * A video element of our own on the learner's existing camera stream (not a second camera stream:
 * the same MediaStream, another viewer), kept out of the page so it plays whether or not the
 * preview is shown. `release` detaches it.
 */
export function detectionVideo(stream: MediaStream): { video: HTMLVideoElement; release: () => void } {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;
  void video.play().catch(() => {});
  return {
    video,
    release: () => {
      video.pause();
      video.srcObject = null;
    },
  };
}

/**
 * Sample the stream about every 500 ms (every second while inference is slow), only while
 * `shouldSample()` holds (otherwise `onIdle`). A detector that won't load, or inference that keeps
 * failing, is reported through `onUnavailable` — never as a face problem. Returns `stop`.
 */
export function startFaceSampling(
  stream: MediaStream,
  handlers: { shouldSample: () => boolean; onSample: (now: number, sample: FaceSample) => void; onUnavailable: () => void; onIdle?: () => void },
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let detector: FaceDetector | null = null;
  let failures = 0;
  const durations: number[] = [];
  const { video, release } = detectionVideo(stream);

  loadFaceDetector().then(
    (d) => {
      detector = d;
    },
    () => {
      if (!stopped) handlers.onUnavailable();
    },
  );

  function tick() {
    if (stopped) return;
    if (!handlers.shouldSample()) handlers.onIdle?.();
    else if (detector) {
      try {
        const started = performance.now();
        const sample = detectFaces(detector, video);
        if (sample) {
          durations.push(performance.now() - started);
          if (durations.length > 10) durations.shift();
          failures = 0;
          handlers.onSample(performance.now(), sample);
        }
      } catch {
        // A browser hiccup now and then is ignored; repeated failures mean detection is unavailable.
        if (++failures >= 3) handlers.onUnavailable();
      }
    }
    const average = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    timer = setTimeout(tick, average > FACE_RULES.slowInferenceMs ? FACE_RULES.slowSampleMs : FACE_RULES.sampleMs);
  }
  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    release();
  };
}
