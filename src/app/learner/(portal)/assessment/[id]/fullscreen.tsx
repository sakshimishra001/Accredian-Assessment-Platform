"use client";

import { useSyncExternalStore } from "react";
import { Maximize, MonitorX } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FullscreenResult } from "@/lib/proctoring/fullscreen-monitor";

/*
 * Fullscreen enforcement in the learner's exam, with the standard Fullscreen API. The browser decides
 * whether fullscreen was entered and the learner can always leave it (Esc, OS shortcuts): this only
 * asks for fullscreen, notices exits and reports them — it is not a secure or locked-down browser.
 */

export const fullscreenSupported = () => typeof document !== "undefined" && document.fullscreenEnabled === true && typeof document.documentElement.requestFullscreen === "function";
export const isFullscreen = () => typeof document !== "undefined" && !!document.fullscreenElement;

const noSubscription = () => () => {};
/** Whether this browser can do fullscreen (assumed yes while rendering on the server). */
export const useFullscreenSupported = () => useSyncExternalStore(noSubscription, fullscreenSupported, () => true);

/**
 * Ask for fullscreen. Must be called directly from the learner's click (browsers require a user
 * gesture). Resolves to what actually happened — never assumes success.
 */
export async function enterFullscreen(): Promise<FullscreenResult> {
  if (!fullscreenSupported()) return "unsupported";
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
  } catch {
    return "denied";
  }
  return isFullscreen() ? "ok" : "denied";
}

/** Leave fullscreen when the exam is over (submitted, locked or terminated). */
export function leaveFullscreen() {
  if (isFullscreen()) void document.exitFullscreen().catch(() => {});
}

export const FULLSCREEN_UNSUPPORTED = "This assessment must be taken in fullscreen, which this browser doesn’t support. Please use a supported desktop browser (for example Chrome, Edge, Firefox or Safari on a computer).";
export const FULLSCREEN_DENIED = "Fullscreen couldn’t be entered. Allow fullscreen for this site if your browser asks, then try again.";

export type Action = "LOCK" | "TERMINATE" | "WARN";

/** What happens with further violations (shared by the fullscreen and camera gates). */
export function policyText(action: Action, violations: number, max: number) {
  if (action === "WARN") return "Each exit is recorded for the administrator.";
  const left = max - violations;
  const outcome = action === "LOCK" ? "locked" : "terminated";
  return left > 0 ? `${left === 1 ? "One more violation" : `${left} more violations`} and your exam will be ${outcome}.` : `Further violations may get your exam ${outcome}.`;
}

/** Before the exam: what fullscreen enforcement means for the learner. */
export function FullscreenRequirement({ action, maxViolations }: { action: Action; maxViolations: number }) {
  return (
    <section aria-labelledby="fs-title" className="rounded-xl border bg-card p-5">
      <h2 id="fs-title" className="flex items-center gap-2 text-base font-semibold">
        <Maximize className="size-4 text-primary" aria-hidden /> Fullscreen mode is required for this assessment
      </h2>
      <ul className="mt-3 grid list-disc gap-1.5 pl-5 text-sm text-muted-foreground">
        <li>The assessment must stay in fullscreen mode from start to finish.</li>
        <li>Leaving fullscreen is recorded as a proctoring violation.</li>
        <li>
          Violations are limited to {maxViolations}; {action === "WARN" ? "beyond that they are recorded for the administrator." : `at the limit your exam is ${action === "LOCK" ? "locked" : "terminated"}.`}
        </li>
        <li>Fullscreen needs a desktop browser that supports it.</li>
      </ul>
    </section>
  );
}

/**
 * During the exam, while not in fullscreen: covers the questions until the learner returns.
 * `exited` — they just left; otherwise fullscreen is required again (e.g. after a reload or resume).
 */
export function FullscreenGate({
  exited,
  supported,
  violations,
  maxViolations,
  action,
  error,
  onReturn,
}: {
  exited: boolean;
  supported: boolean;
  violations: number;
  maxViolations: number;
  action: Action;
  error: string | null;
  onReturn: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/95 px-4 backdrop-blur-sm" role="alertdialog" aria-modal="true" aria-labelledby="fsgate-title" aria-describedby="fsgate-body">
      <div className="w-full max-w-md rounded-xl border bg-card p-7 text-center shadow-sm">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-amber-50 text-amber-700">
          <MonitorX className="size-6" aria-hidden />
        </span>
        <h2 id="fsgate-title" className="mt-4 text-lg font-semibold tracking-tight">
          {!supported ? "Fullscreen isn’t available" : exited ? "Fullscreen mode exited" : "Fullscreen mode required"}
        </h2>
        <div id="fsgate-body" className="mt-2 grid gap-2 text-sm text-muted-foreground">
          {!supported ? (
            <p>{FULLSCREEN_UNSUPPORTED}</p>
          ) : (
            <>
              <p>Please return to fullscreen to continue your assessment. Your answers are saved and the timer keeps running.</p>
              {violations > 0 ? (
                <p className="font-medium text-foreground">
                  Violation {violations} of {maxViolations}
                </p>
              ) : null}
              {violations > 0 ? <p>{policyText(action, violations, maxViolations)}</p> : null}
            </>
          )}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        {supported ? (
          <Button className="mt-5" onClick={onReturn} autoFocus>
            <Maximize /> Return to Fullscreen
          </Button>
        ) : null}
      </div>
    </div>
  );
}
