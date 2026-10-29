/*
 * Short alert tones, synthesized in the browser with the Web Audio API — no audio files, no
 * dependency, nothing fetched. Each is well under a second and quiet. Browsers allow sound only
 * after the user has interacted with the page; `unlockAudio()` (called from a click, or on the first
 * key press / pointer press) enables it. Playing never throws: when audio is unavailable or still
 * locked, nothing happens.
 */

export type AlertTone = "violation" | "notification";

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (context) return context;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    return null;
  }
  return context;
}

/** Enable sound (from a user interaction): creates or resumes the audio context. Resolves once it is running (or can't be). */
export async function unlockAudio(): Promise<void> {
  const ctx = audioContext();
  if (ctx && ctx.state === "suspended") await ctx.resume().catch(() => {});
}

/** Unlock on the page's first key or pointer press (for pages where sound plays without a dedicated control). */
export function unlockAudioOnFirstInteraction(): () => void {
  if (typeof window === "undefined") return () => {};
  const unlock = () => {
    void unlockAudio();
    remove();
  };
  const remove = () => {
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
  return remove;
}

/** Notes (Hz, start offset s, length s) per tone: a low double beep for a violation, a soft rising chime for a message. */
const TONES: Record<AlertTone, { freq: number; at: number; len: number; type: OscillatorType }[]> = {
  violation: [
    { freq: 440, at: 0, len: 0.12, type: "square" },
    { freq: 349, at: 0.16, len: 0.16, type: "square" },
  ],
  notification: [
    { freq: 784, at: 0, len: 0.14, type: "sine" },
    { freq: 1047, at: 0.12, len: 0.22, type: "sine" },
  ],
};
const VOLUME: Record<AlertTone, number> = { violation: 0.05, notification: 0.08 };

/** Play a tone (no-op when audio is unavailable or not yet unlocked). */
export function playTone(tone: AlertTone) {
  const ctx = audioContext();
  if (!ctx || ctx.state !== "running") return;
  try {
    const start = ctx.currentTime + 0.01;
    for (const note of TONES[tone]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = note.type;
      osc.frequency.value = note.freq;
      // A quick fade in and out: no clicks.
      gain.gain.setValueAtTime(0, start + note.at);
      gain.gain.linearRampToValueAtTime(VOLUME[tone], start + note.at + 0.01);
      gain.gain.linearRampToValueAtTime(0, start + note.at + note.len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start + note.at);
      osc.stop(start + note.at + note.len + 0.02);
    }
  } catch {
    // Audio is only a cue.
  }
}
