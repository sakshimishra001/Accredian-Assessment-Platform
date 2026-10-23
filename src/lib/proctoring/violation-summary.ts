import type { ProctoringEventType } from "@/generated/prisma/enums";

/*
 * Violations by kind, for the proctor dashboard. The attempt keeps one shared counter (it decides
 * the WARN / LOCK / TERMINATE action and is never changed here); the per-kind counts are grouped from
 * the recorded violation events (those with a violation number), so they always add up to what the
 * server counted.
 */

export interface ViolationSummary {
  focus: number;
  fullscreen: number;
  clipboardCopy: number;
  clipboardCut: number;
  clipboardPaste: number;
  /** Copy + cut + paste. */
  clipboard: number;
  /** Camera and face events (not monitored on the dashboard yet, but part of the total). */
  other: number;
  total: number;
}

export const EMPTY_VIOLATIONS: ViolationSummary = { focus: 0, fullscreen: 0, clipboardCopy: 0, clipboardCut: 0, clipboardPaste: 0, clipboard: 0, other: 0, total: 0 };

/** Group counted violation events (`count` per event type) into the dashboard's kinds. */
export function summarizeViolations(rows: readonly { eventType: ProctoringEventType; count: number }[]): ViolationSummary {
  const s = { ...EMPTY_VIOLATIONS };
  for (const { eventType, count } of rows) {
    switch (eventType) {
      case "FOCUS_LOST":
        s.focus += count;
        break;
      case "FULLSCREEN_EXIT":
        s.fullscreen += count;
        break;
      case "CLIPBOARD_COPY":
        s.clipboardCopy += count;
        break;
      case "CLIPBOARD_CUT":
        s.clipboardCut += count;
        break;
      case "CLIPBOARD_PASTE":
        s.clipboardPaste += count;
        break;
      case "PROCTORING_STARTED":
      case "PROCTORING_STOPPED":
        // System events are never violations.
        continue;
      default:
        s.other += count;
    }
    s.total += count;
  }
  s.clipboard = s.clipboardCopy + s.clipboardCut + s.clipboardPaste;
  return s;
}

/** The same summary from individual events (counted violations only — those with a violation number). */
export function summarizeEvents(events: readonly { eventType: ProctoringEventType; violationNumber: number | null }[]): ViolationSummary {
  return summarizeViolations(events.filter((e) => e.violationNumber !== null).map((e) => ({ eventType: e.eventType, count: 1 })));
}
