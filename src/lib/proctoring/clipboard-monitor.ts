/*
 * Clipboard monitoring in the browser, with no DOM of its own (the exam screen wires it to the
 * document's copy / cut / paste events). It only notices *that* a clipboard operation happened and
 * reports it; it never cancels the operation and never reads what was copied or pasted. The server
 * decides whether it counts, the violation number and any action.
 *
 * Each operation is reported once: a listener sees each ClipboardEvent once even if the browser
 * delivers it to more than one handler, while separate operations (copy, then paste) are separate.
 */

export type ClipboardEventType = "CLIPBOARD_COPY" | "CLIPBOARD_CUT" | "CLIPBOARD_PASTE";

export const CLIPBOARD_EVENT: Record<"copy" | "cut" | "paste", ClipboardEventType> = { copy: "CLIPBOARD_COPY", cut: "CLIPBOARD_CUT", paste: "CLIPBOARD_PASTE" };

export function createClipboardMonitor(opts: { isIdle: () => boolean; report: (type: ClipboardEventType) => void }) {
  const seen = new WeakSet<object>();
  return {
    /** Call from the copy / cut / paste listeners with the browser event (its contents are never read). */
    handle(kind: "copy" | "cut" | "paste", event: object) {
      if (seen.has(event)) return false;
      seen.add(event);
      if (opts.isIdle()) return false;
      opts.report(CLIPBOARD_EVENT[kind]);
      return true;
    },
  };
}
