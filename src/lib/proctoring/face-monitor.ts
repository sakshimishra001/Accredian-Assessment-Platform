/*
 * Face detection in the learner's exam, as a small state machine with no DOM and no model of its
 * own: the exam screen feeds it samples (how many faces the in-browser detector found, with each
 * one's score and size) and it decides when a *sustained* condition is reported. It never sees an
 * image and keeps nothing but counts and times. The server decides whether a report counts, the
 * violation number and any action.
 *
 * Built to avoid false positives:
 * - a face counts only when the detector is confident and it isn't a small background face;
 * - a missing face is reported only after it has been missing continuously for a while (the
 *   learner sees a notice well before then); one flicker of detection doesn't reset that clock;
 * - several faces are reported only when they persist across most samples of a few seconds;
 * - one continuous condition is one report: it ends only once clear for a few seconds, and a
 *   cooldown per event type follows;
 * - nothing is reported while idle (paused, locked, closing) or while detection is unavailable —
 *   a detector failure is never the learner's violation.
 * A missing face is a departure: it shares the incident with focus / fullscreen / camera, so one
 * physical departure is one violation.
 */

/** One face found by the detector: its confidence and its width as a fraction of the frame's width. */
export interface FaceDetection {
  score: number;
  width: number;
}

export interface FaceSample {
  faces: readonly FaceDetection[];
}

export const FACE_RULES = {
  /** Detection runs about this often… */
  sampleMs: 500,
  /** …or this often when inference is slow (averaging over slowInferenceMs). */
  slowSampleMs: 1_000,
  slowInferenceMs: 50,
  /** A face counts from this confidence… */
  minScore: 0.6,
  /** …a second face only from this one… */
  minSecondScore: 0.7,
  /** …and either only at this width or more (fraction of the frame): small background faces don't count. */
  minWidth: 0.1,
  /** The learner is told their face isn't visible after this long… */
  missingNoticeMs: 2_000,
  /** …and FACE_NOT_DETECTED is reported after this long without a face. */
  missingReportMs: 10_000,
  /** This many consecutive samples with a face reset the missing-face clock. */
  presentResetSamples: 2,
  /** MULTIPLE_FACES: a second face in at least this share of the samples of this window. */
  multipleWindowMs: 5_000,
  multipleRatio: 0.8,
  /** A reported condition ends once clear for this long… */
  clearMs: 3_000,
  /** …and the same event type isn't reported again within this long of the last report. */
  cooldownMs: 30_000,
} as const;

export type FaceRules = { [K in keyof typeof FACE_RULES]: number };

/** How many faces a sample shows, by the rules: 0, 1, or 2+ (each extra face must clear the stricter bar). */
export function countFaces(sample: FaceSample, rules: FaceRules = FACE_RULES): number {
  const valid = sample.faces.filter((f) => f.score >= rules.minScore && f.width >= rules.minWidth).sort((a, b) => b.score - a.score);
  if (valid.length === 0) return 0;
  return 1 + valid.slice(1).filter((f) => f.score >= rules.minSecondScore).length;
}

/** What the learner is shown: never a verdict, only what the camera currently sees. */
export type FaceStatus = "starting" | "detected" | "missing" | "multiple" | "unavailable";

export type FaceEventType = "FACE_NOT_DETECTED" | "MULTIPLE_FACES";

export interface FaceReport {
  eventType: FaceEventType;
  incidentId: string;
  /** How long the condition had lasted when reported. */
  durationMs: number;
  /** Faces counted (0 for a missing face). */
  faces: number;
}

export function createFaceMonitor(opts: {
  /** Paused, locked or closing: nothing is reported. */
  isIdle: () => boolean;
  /** Which events are switched on for the assessment (the server checks again). */
  events: { missing: boolean; multiple: boolean };
  report: (r: FaceReport) => void;
  /** The departure tracker shared with focus / fullscreen / camera. */
  departures: { leave(source: "face"): string; back(source: "face"): void };
  newId: () => string;
  rules?: Partial<FaceRules>;
}) {
  const r: FaceRules = { ...FACE_RULES, ...opts.rules };
  let status: FaceStatus = "starting";

  // Missing face.
  let missingSince: number | null = null;
  let presentRun = 0;
  let missingEpisode = false;
  let missingClearSince: number | null = null;

  // Several faces.
  let window: { t: number; faces: number }[] = [];
  let multipleEpisode = false;
  let multipleClearSince: number | null = null;

  const lastReport: Record<FaceEventType, number> = { FACE_NOT_DETECTED: -Infinity, MULTIPLE_FACES: -Infinity };
  const coolingDown = (type: FaceEventType, now: number) => now - lastReport[type] < r.cooldownMs;

  function endMissingEpisode() {
    if (missingEpisode) opts.departures.back("face");
    missingEpisode = false;
    missingClearSince = null;
  }

  /** Forget every running timer and episode (cooldowns stay): after idle, a hidden page, a camera gate or a detector failure. */
  function reset() {
    missingSince = null;
    presentRun = 0;
    endMissingEpisode();
    window = [];
    multipleEpisode = false;
    multipleClearSince = null;
  }

  function trackMissing(now: number, count: number) {
    if (count >= 1) {
      presentRun++;
      if (presentRun >= r.presentResetSamples) missingSince = null;
      if (missingEpisode) {
        missingClearSince ??= now;
        if (now - missingClearSince >= r.clearMs) endMissingEpisode();
      }
      return;
    }
    presentRun = 0;
    missingClearSince = null;
    missingSince ??= now;
    const lasted = now - missingSince;
    if (opts.events.missing && !missingEpisode && lasted >= r.missingReportMs && !coolingDown("FACE_NOT_DETECTED", now)) {
      missingEpisode = true;
      lastReport.FACE_NOT_DETECTED = now;
      opts.report({ eventType: "FACE_NOT_DETECTED", incidentId: opts.departures.leave("face"), durationMs: lasted, faces: 0 });
    }
  }

  function trackMultiple(now: number, count: number) {
    window.push({ t: now, faces: count });
    window = window.filter((s) => now - s.t < r.multipleWindowMs);
    if (count >= 2) multipleClearSince = null;
    else if (multipleEpisode) {
      multipleClearSince ??= now;
      if (now - multipleClearSince >= r.clearMs) {
        multipleEpisode = false;
        multipleClearSince = null;
      }
    }
    // The window must cover (about) the whole period, not just the last couple of samples.
    const covered = now - window[0].t >= r.multipleWindowMs - r.slowSampleMs;
    const several = window.filter((s) => s.faces >= 2);
    if (opts.events.multiple && !multipleEpisode && covered && several.length / window.length >= r.multipleRatio && !coolingDown("MULTIPLE_FACES", now)) {
      multipleEpisode = true;
      lastReport.MULTIPLE_FACES = now;
      opts.report({ eventType: "MULTIPLE_FACES", incidentId: opts.newId(), durationMs: now - window[0].t, faces: Math.max(...several.map((s) => s.faces)) });
    }
  }

  return {
    /** A detection result at `now` (ms, monotonic). Returns the status to show. */
    sample(now: number, sample: FaceSample): FaceStatus {
      if (opts.isIdle()) {
        reset();
        status = "starting";
        return status;
      }
      const count = countFaces(sample, r);
      trackMissing(now, count);
      trackMultiple(now, count);
      if (count >= 2) status = "multiple";
      else if (count === 1) status = "detected";
      else if (missingSince !== null && now - missingSince >= r.missingNoticeMs) status = "missing";
      return status;
    },
    /** Detection isn't possible (model or inference failure): never a violation. */
    unavailable(): FaceStatus {
      reset();
      status = "unavailable";
      return status;
    },
    /** Monitoring stopped for a while (paused, hidden page, camera gate): start afresh next time. */
    reset(): FaceStatus {
      reset();
      if (status !== "unavailable") status = "starting";
      return status;
    },
    status: () => status,
  };
}
