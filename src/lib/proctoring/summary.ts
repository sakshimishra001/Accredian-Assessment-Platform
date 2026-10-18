import type { FocusViolationAction } from "@/generated/prisma/enums";
import { effectiveProctoring, VIOLATION_ACTION_LABEL, type ProctoringSettings } from "./config";

/** One line for the review step and the assessment details: what is in force, the limit and action. */
export function proctoringSummary(s: ProctoringSettings & { focusMaxViolations: number; focusViolationAction: FocusViolationAction }) {
  const p = effectiveProctoring(s);
  if (!p.enabled) return "Off";
  const controls = [
    p.focus && "Focus monitoring",
    p.fullscreen && "Fullscreen",
    p.clipboard && "Clipboard",
    p.camera && `Camera${p.faceDetection ? ` (face detection${p.multipleFaces ? ", multiple faces" : ""}${p.faceMissing ? ", face missing" : ""})` : ""}`,
  ].filter(Boolean);
  return `On · ${controls.length ? controls.join(", ") : "no controls selected"} · limit ${s.focusMaxViolations}, then ${VIOLATION_ACTION_LABEL[s.focusViolationAction]}`;
}
