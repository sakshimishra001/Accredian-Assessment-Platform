import { describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";
import { CAMERA_CONSTRAINTS, cameraLossType, cameraProblem, createCameraMonitor, streamIsLive } from "@/lib/proctoring/camera-monitor";
import { effectiveProctoring, eventEnabled, eventSeverity, isViolation } from "@/lib/proctoring/config";
import { createDepartureTracker } from "@/lib/proctoring/fullscreen-monitor";

/*
 * Proctoring V1 step 4: camera permission and the pre-exam camera check. The browser side has no
 * DOM of its own here — these are the rules it follows.
 */

const err = (name: string) => Object.assign(new Error(name), { name });

describe("camera request", () => {
  it("asks for video only — never the microphone", () => {
    expect(CAMERA_CONSTRAINTS.audio).toBe(false);
    expect(CAMERA_CONSTRAINTS.video).toBeTruthy();
  });

  it("explains each getUserMedia failure: denied, no camera, unavailable, blocked", () => {
    expect(cameraProblem(err("NotAllowedError"))).toBe("denied");
    expect(cameraProblem(err("PermissionDeniedError"))).toBe("denied");
    expect(cameraProblem(err("NotFoundError"))).toBe("not-found");
    expect(cameraProblem(err("OverconstrainedError"))).toBe("not-found");
    expect(cameraProblem(err("NotReadableError"))).toBe("unavailable");
    expect(cameraProblem(err("AbortError"))).toBe("unavailable");
    expect(cameraProblem(err("SecurityError"))).toBe("blocked");
    expect(cameraProblem("something odd")).toBe("unavailable");
    expect(cameraProblem(null)).toBe("unavailable");
  });

  it("a stream is live only while a video track is", () => {
    const stream = (...states: string[]) => ({ getVideoTracks: () => states.map((readyState) => ({ readyState })) });
    expect(streamIsLive(stream("live"))).toBe(true);
    expect(streamIsLive(stream("ended"))).toBe(false);
    expect(streamIsLive(stream())).toBe(false);
    expect(streamIsLive(null)).toBe(false);
  });
});

describe("camera loss", () => {
  it("a lost permission is a revocation; otherwise the camera was turned off", () => {
    expect(cameraLossType("denied")).toBe("CAMERA_PERMISSION_REVOKED");
    expect(cameraLossType("prompt")).toBe("CAMERA_PERMISSION_REVOKED");
    expect(cameraLossType("granted")).toBe("CAMERA_DISABLED");
    expect(cameraLossType(null)).toBe("CAMERA_DISABLED");
  });

  it("reports one loss once, only after the check was passed, and again after it is passed again", () => {
    const onLoss = vi.fn();
    const m = createCameraMonitor({ isIdle: () => false, onLoss });
    expect(m.lost("CAMERA_DISABLED")).toBe(false); // never on: nothing to lose
    m.ready();
    expect(m.lost("CAMERA_PERMISSION_REVOKED")).toBe(true);
    expect(m.lost("CAMERA_DISABLED")).toBe(false); // the track ending after a revocation is the same loss
    m.ready();
    expect(m.lost("CAMERA_DISABLED")).toBe(true);
    expect(onLoss.mock.calls).toEqual([["CAMERA_PERMISSION_REVOKED"], ["CAMERA_DISABLED"]]);
  });

  it("a loss while paused, locked or closing is not reported (now or later)", () => {
    let idle = true;
    const onLoss = vi.fn();
    const m = createCameraMonitor({ isIdle: () => idle, onLoss });
    m.ready();
    expect(m.lost("CAMERA_DISABLED")).toBe(false);
    idle = false;
    expect(m.lost("CAMERA_DISABLED")).toBe(false);
    expect(onLoss).not.toHaveBeenCalled();
    expect(m.isLive()).toBe(false);
  });

  it("a camera loss and the fullscreen exit made to fix it are one departure (one incident)", () => {
    let n = 0;
    const t = createDepartureTracker(() => `id-${++n}`);
    const camera = t.leave("camera");
    expect(t.leave("fullscreen")).toBe(camera);
    t.back("camera");
    expect(t.leave("focus")).toBe(camera); // still away from fullscreen
    t.back("fullscreen");
    t.back("focus");
    expect(t.leave("camera")).not.toBe(camera);
  });
});

describe("camera configuration", () => {
  const OFF = { proctoringEnabled: false, focusMonitoringEnabled: false, fullscreenEnabled: false, clipboardMonitoringEnabled: false, cameraRequired: false, faceDetectionEnabled: false, multipleFaceDetectionEnabled: false, faceMissingDetectionEnabled: false };

  it("camera events apply only with proctoring on and the camera required", () => {
    for (const [settings, on] of [
      [{ ...OFF, proctoringEnabled: true, cameraRequired: true }, true],
      [{ ...OFF, proctoringEnabled: false, cameraRequired: true }, false],
      [{ ...OFF, proctoringEnabled: true, cameraRequired: false }, false],
    ] as const) {
      const p = effectiveProctoring(settings);
      expect(p.camera).toBe(on);
      expect(eventEnabled("CAMERA_DISABLED", p)).toBe(on);
      expect(eventEnabled("CAMERA_PERMISSION_REVOKED", p)).toBe(on);
    }
  });

  it("camera events are violations (shared limit and action)", () => {
    expect(isViolation("CAMERA_DISABLED")).toBe(true);
    expect(isViolation("CAMERA_PERMISSION_REVOKED")).toBe(true);
    expect(eventSeverity("CAMERA_DISABLED", null)).toBe("MEDIUM");
    expect(eventSeverity("CAMERA_PERMISSION_REVOKED", null)).toBe("HIGH");
  });
});

describe("Permissions-Policy", () => {
  it("allows the camera (this origin only) on the learner's exam pages and nowhere else; never the microphone", async () => {
    const rules = await nextConfig.headers!();
    const policy = (r: (typeof rules)[number]) => r.headers.find((h) => h.key === "Permissions-Policy")?.value;
    const exam = rules.findIndex((r) => r.source === "/learner/assessment/:path*");
    expect(exam).toBe(rules.length - 1); // last, so it wins over the site-wide rule
    expect(policy(rules[exam])).toMatch(/(^|, )camera=\(self\)(,|$)/);
    // Every other rule that sets the policy keeps the camera off (asset rules, e.g. caching, set none).
    for (const r of rules.slice(0, exam).filter(policy)) expect(policy(r)).toMatch(/(^|, )camera=\(\)(,|$)/);
    expect(rules.slice(0, exam).filter(policy).length).toBeGreaterThan(0);
    for (const r of rules) {
      const p = policy(r);
      if (p) expect(p).toMatch(/(^|, )microphone=\(\)(,|$)/);
    }
  });
});
