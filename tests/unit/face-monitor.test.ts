import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveProctoring, eventEnabled, learnerCameraConfig, type ProctoringSettings } from "@/lib/proctoring/config";
import { FACE_MODEL_PATH, FACE_WASM_PATH, MEDIAPIPE_VERSION } from "@/lib/proctoring/face-assets";
import { countFaces, createFaceMonitor, FACE_RULES, type FaceDetection, type FaceReport } from "@/lib/proctoring/face-monitor";
import { createDepartureTracker } from "@/lib/proctoring/fullscreen-monitor";

/*
 * Proctoring step 5: face detection. The state machine is fed detector samples (faces with a score
 * and a width as a fraction of the frame) and decides when a sustained condition is reported. No
 * model, camera or browser is needed here.
 */

const ONE = [{ score: 0.9, width: 0.3 }];
const NONE: FaceDetection[] = [];
const TWO = [
  { score: 0.92, width: 0.3 },
  { score: 0.85, width: 0.2 },
];

function harness(opts: { events?: { missing: boolean; multiple: boolean }; departures?: ReturnType<typeof createDepartureTracker> } = {}) {
  let now = 0;
  let idle = false;
  let n = 0;
  const reports: FaceReport[] = [];
  const departures = opts.departures ?? createDepartureTracker(() => `dep-${++n}`);
  const monitor = createFaceMonitor({
    isIdle: () => idle,
    events: opts.events ?? { missing: true, multiple: true },
    report: (r) => reports.push(r),
    departures,
    newId: () => `inc-${++n}`,
  });
  /** Feed the same faces every 500 ms for `ms`; returns the last status. */
  function run(faces: readonly FaceDetection[], ms: number) {
    let status = monitor.status();
    for (let t = 0; t < ms; t += FACE_RULES.sampleMs) {
      now += FACE_RULES.sampleMs;
      status = monitor.sample(now, { faces });
    }
    return status;
  }
  return {
    monitor,
    reports,
    departures,
    run,
    setIdle: (v: boolean) => {
      idle = v;
    },
    types: () => reports.map((r) => r.eventType),
  };
}

describe("face classification", () => {
  it("1: one face is normal — status \"detected\", nothing reported", () => {
    const h = harness();
    expect(h.run(ONE, 60_000)).toBe("detected");
    expect(h.reports).toEqual([]);
  });

  it("10: small/background faces (under ~10% of the frame width) don't count", () => {
    expect(countFaces({ faces: [{ score: 0.95, width: 0.05 }] })).toBe(0);
    expect(countFaces({ faces: [...ONE, { score: 0.95, width: 0.06 }] })).toBe(1);
  });

  it("11: score thresholds — a face from 0.6, a second face only from 0.7", () => {
    expect(countFaces({ faces: [{ score: 0.59, width: 0.3 }] })).toBe(0);
    expect(countFaces({ faces: [{ score: 0.6, width: 0.3 }] })).toBe(1);
    expect(countFaces({ faces: [ONE[0], { score: 0.65, width: 0.3 }] })).toBe(1);
    expect(countFaces({ faces: [ONE[0], { score: 0.7, width: 0.3 }] })).toBe(2);
  });
});

describe("FACE_NOT_DETECTED", () => {
  it("2: a briefly missed detection (or brief movement) creates no event; the notice only shows after ~2 s", () => {
    const h = harness();
    h.run(ONE, 2_000);
    expect(h.run(NONE, 1_500)).toBe("detected");
    expect(h.run(NONE, 1_000)).toBe("missing");
    h.run(ONE, 1_000);
    h.run(ONE, 60_000);
    expect(h.reports).toEqual([]);
  });

  it("3: reported once the face has been missing for ~10 s — not before", () => {
    const h = harness();
    h.run(ONE, 2_000);
    h.run(NONE, 9_000);
    expect(h.reports).toEqual([]);
    h.run(NONE, 1_500);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ eventType: "FACE_NOT_DETECTED", faces: 0 });
    expect(h.reports[0].durationMs).toBeGreaterThanOrEqual(FACE_RULES.missingReportMs);
  });

  it("4: two consecutive face samples reset the missing timer; a single flicker doesn't", () => {
    const h = harness();
    h.run(NONE, 8_000);
    h.run(ONE, 1_000); // two samples: reset
    h.run(NONE, 8_000);
    expect(h.reports).toEqual([]);

    const f = harness();
    f.run(NONE, 8_000);
    f.run(ONE, 500); // one flicker: no reset
    f.run(NONE, 2_500);
    expect(f.types()).toEqual(["FACE_NOT_DETECTED"]);
  });

  it("7: one continuous episode is one event, however long it lasts", () => {
    const h = harness();
    h.run(NONE, 5 * 60_000);
    expect(h.types()).toEqual(["FACE_NOT_DETECTED"]);
  });

  it("9: the condition must clear (~3 s) before a new episode can be reported", () => {
    const h = harness();
    h.run(NONE, 11_000);
    h.run(ONE, 2_000); // back, but not clear for 3 s yet
    h.run(NONE, 60_000); // …so this is still the same episode
    expect(h.types()).toEqual(["FACE_NOT_DETECTED"]);
    h.run(ONE, 4_000); // clear: the episode ends
    h.run(NONE, 11_000);
    expect(h.types()).toEqual(["FACE_NOT_DETECTED", "FACE_NOT_DETECTED"]);
  });

  it("8: a 30 s cooldown per type — a new absence right after an episode is reported only once the cooldown is over", () => {
    const h = harness();
    h.run(NONE, 10_500); // reported at ~10 s
    h.run(ONE, 4_000); // episode over
    h.run(NONE, 11_000); // missing again for 11 s, ending ~25 s after the first report (at ~10.5 s)
    expect(h.reports).toHaveLength(1);
    h.run(NONE, 10_000); // ~35.5 s: still inside the 30 s cooldown
    expect(h.reports).toHaveLength(1);
    h.run(NONE, 6_000); // ~41.5 s: still missing once the cooldown has passed — reported
    expect(h.reports[1].durationMs).toBeGreaterThan(FACE_RULES.missingReportMs);
    expect(h.types()).toEqual(["FACE_NOT_DETECTED", "FACE_NOT_DETECTED"]);
  });
});

describe("MULTIPLE_FACES", () => {
  it("5: a second face in one frame (or briefly) creates no event", () => {
    const h = harness();
    h.run(ONE, 3_000);
    expect(h.run(TWO, 500)).toBe("multiple");
    h.run(ONE, 5_000);
    h.run(TWO, 2_000);
    h.run(ONE, 30_000);
    expect(h.reports).toEqual([]);
  });

  it("6: a second face in ≥80% of samples over ~5 s (so after about 4 s) is reported as MULTIPLE_FACES with the face count", () => {
    const h = harness();
    h.run(ONE, 3_000);
    h.run(TWO, 3_500);
    expect(h.reports).toEqual([]); // 70% of the window
    h.run(TWO, 500); // 80%
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ eventType: "MULTIPLE_FACES", faces: 2 });
  });

  it("80% is enough: an occasional missed second face doesn't prevent it", () => {
    const h = harness();
    for (let i = 0; i < 4; i++) {
      h.run(TWO, 2_000);
      h.run(ONE, 500);
    }
    expect(h.types()).toEqual(["MULTIPLE_FACES"]);
  });

  it("7/8/9: one event per continuous episode; it must clear, and the cooldown applies", () => {
    const h = harness();
    h.run(TWO, 120_000);
    expect(h.types()).toEqual(["MULTIPLE_FACES"]);
    h.run(ONE, 4_000);
    h.run(TWO, 6_000); // inside the 30 s cooldown? no — 120 s have passed since the report
    expect(h.types()).toEqual(["MULTIPLE_FACES", "MULTIPLE_FACES"]);
    h.run(ONE, 4_000);
    h.run(TWO, 6_000); // within 30 s of the last report: cooling down
    expect(h.reports).toHaveLength(2);
  });
});

describe("silent states", () => {
  it.each([["12: paused"], ["13: locked"], ["14: closing / terminating"]])("%s — nothing is reported and timers restart", () => {
    const h = harness();
    h.setIdle(true);
    expect(h.run(NONE, 60_000)).toBe("starting");
    h.run(TWO, 60_000);
    expect(h.reports).toEqual([]);
    // After the idle period, absence is counted from zero again.
    h.setIdle(false);
    h.run(NONE, 9_000);
    expect(h.reports).toEqual([]);
  });

  it("15: an unavailable detector never creates a violation and abandons a running episode", () => {
    const h = harness();
    h.run(NONE, 8_000);
    expect(h.monitor.unavailable()).toBe("unavailable");
    expect(h.monitor.status()).toBe("unavailable");
    // Detection comes back: absence starts from zero.
    h.run(NONE, 9_000);
    expect(h.reports).toEqual([]);
  });

  it("a reset (hidden page, camera gate) restarts the timers", () => {
    const h = harness();
    h.run(NONE, 8_000);
    h.monitor.reset();
    h.run(NONE, 9_000);
    expect(h.reports).toEqual([]);
  });

  it("switched-off events are never reported", () => {
    const h = harness({ events: { missing: false, multiple: false } });
    h.run(NONE, 30_000);
    h.run(TWO, 30_000);
    expect(h.reports).toEqual([]);
    expect(h.monitor.status()).toBe("multiple"); // the learner still sees what the check sees
  });
});

describe("16: a missing face shares the departure incident with focus / fullscreen / camera", () => {
  it("one physical departure is one incident; the face's return ends its part of it", () => {
    let n = 0;
    const departures = createDepartureTracker(() => `dep-${++n}`);
    const focusIncident = departures.leave("focus"); // the learner switched away…
    const h = harness({ departures });
    h.run(NONE, 11_000); // …and their face is gone too
    expect(h.reports[0].incidentId).toBe(focusIncident); // the same incident: the server counts it once
    departures.back("focus");
    h.run(ONE, 4_000); // face back for 3 s+: the departure is over
    expect(departures.leave("fullscreen")).not.toBe(focusIncident);
  });

  it("MULTIPLE_FACES is not a departure: it gets its own incident", () => {
    let n = 0;
    const departures = createDepartureTracker(() => `dep-${++n}`);
    const away = departures.leave("fullscreen");
    const h = harness({ departures });
    h.run(TWO, 6_000);
    expect(h.reports[0].incidentId).not.toBe(away);
  });
});

describe("configuration (server rules and learner exam data)", () => {
  const OFF: ProctoringSettings = {
    proctoringEnabled: false,
    focusMonitoringEnabled: false,
    fullscreenEnabled: false,
    clipboardMonitoringEnabled: false,
    cameraRequired: false,
    faceDetectionEnabled: false,
    multipleFaceDetectionEnabled: false,
    faceMissingDetectionEnabled: false,
  };
  const policy = { focusMaxViolations: 3, focusViolationAction: "WARN" as const };
  const ALL = { ...OFF, proctoringEnabled: true, cameraRequired: true, faceDetectionEnabled: true, multipleFaceDetectionEnabled: true, faceMissingDetectionEnabled: true };

  it("face events are enabled only with proctoring, camera, face detection and their own switch all on", () => {
    expect(eventEnabled("FACE_NOT_DETECTED", effectiveProctoring(ALL))).toBe(true);
    expect(eventEnabled("MULTIPLE_FACES", effectiveProctoring(ALL))).toBe(true);
    for (const off of ["proctoringEnabled", "cameraRequired", "faceDetectionEnabled"] as const) {
      const p = effectiveProctoring({ ...ALL, [off]: false });
      expect(eventEnabled("FACE_NOT_DETECTED", p)).toBe(false);
      expect(eventEnabled("MULTIPLE_FACES", p)).toBe(false);
    }
    expect(eventEnabled("FACE_NOT_DETECTED", effectiveProctoring({ ...ALL, faceMissingDetectionEnabled: false }))).toBe(false);
    expect(eventEnabled("MULTIPLE_FACES", effectiveProctoring({ ...ALL, faceMissingDetectionEnabled: false }))).toBe(true);
    expect(eventEnabled("MULTIPLE_FACES", effectiveProctoring({ ...ALL, multipleFaceDetectionEnabled: false }))).toBe(false);
  });

  it("the learner's exam data carries face settings only when in force — nothing more", () => {
    expect(learnerCameraConfig({ ...OFF, ...policy })).toBeNull();
    expect(learnerCameraConfig({ ...ALL, proctoringEnabled: false, ...policy })).toBeNull();
    expect(learnerCameraConfig({ ...OFF, proctoringEnabled: true, cameraRequired: true, ...policy })).toEqual({ maxViolations: 3, action: "WARN", faceDetection: null });
    // Saved face settings without the camera never turn face detection on.
    expect(learnerCameraConfig({ ...ALL, cameraRequired: false, ...policy })).toBeNull();
    expect(learnerCameraConfig({ ...ALL, ...policy })).toEqual({ maxViolations: 3, action: "WARN", faceDetection: { missing: true, multiple: true } });
    expect(learnerCameraConfig({ ...ALL, multipleFaceDetectionEnabled: false, ...policy })!.faceDetection).toEqual({ missing: true, multiple: false });
  });
});

describe("self-hosted assets", () => {
  const root = path.resolve(__dirname, "../..");

  it("are served from our own domain, for the pinned MediaPipe version", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.dependencies["@mediapipe/tasks-vision"]).toBe(MEDIAPIPE_VERSION); // exact pin
    expect(JSON.parse(readFileSync(path.join(root, "node_modules/@mediapipe/tasks-vision/package.json"), "utf8")).version).toBe(MEDIAPIPE_VERSION);
    for (const p of [FACE_WASM_PATH, FACE_MODEL_PATH]) expect(p).toMatch(/^\/vendor\/mediapipe\//);
  });

  it("the model kept in the repository matches the checksum the copy script enforces", () => {
    const script = readFileSync(path.join(root, "scripts/copy-mediapipe-assets.mjs"), "utf8");
    const recorded = script.match(/sha256: "([0-9a-f]{64})"/)![1];
    const actual = createHash("sha256").update(readFileSync(path.join(root, "assets/mediapipe/blaze_face_short_range.tflite"))).digest("hex");
    expect(actual).toBe(recorded);
  });
});
