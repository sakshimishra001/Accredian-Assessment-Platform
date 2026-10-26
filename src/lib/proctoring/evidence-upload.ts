import type { EvidenceType } from "./evidence";

/*
 * Sending one evidence snapshot from the exam page (proctor dashboard, phase 7). Best-effort: it
 * never throws and the exam never waits for it. A network error or server error is retried once
 * after a short delay; a refusal (not running, too soon, not collected, signed out) is not. The
 * image is dropped afterwards either way — nothing accumulates in the browser.
 */

export type UploadOutcome = "stored" | "refused" | "failed";

/** Wait before the single retry. */
export const EVIDENCE_RETRY_MS = 20_000;

export async function uploadSnapshot(
  attemptId: string,
  type: EvidenceType,
  image: Blob,
  opts: { fetch?: typeof fetch; retryMs?: number; sleep?: (ms: number) => Promise<void>; stopped?: () => boolean } = {},
): Promise<UploadOutcome> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `/api/attempts/${encodeURIComponent(attemptId)}/evidence`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await sleep(opts.retryMs ?? EVIDENCE_RETRY_MS);
      if (opts.stopped?.()) return "failed";
    }
    try {
      const form = new FormData();
      form.set("type", type);
      form.set("file", image, `${type.toLowerCase()}.jpg`);
      const res = await doFetch(url, { method: "POST", body: form });
      if (res.ok) return "stored";
      if (res.status < 500) return "refused";
    } catch {
      // Offline for a moment: retried once.
    }
  }
  return "failed";
}
