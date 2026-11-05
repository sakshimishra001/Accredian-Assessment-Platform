/*
 * Short alert tones, synthesized in the browser with the Web Audio API — no audio files, no
 * dependency, nothing fetched. Each is well under a second and quiet. Browsers allow sound only
 * after the user has interacted with the page; `unlockAudio()` (called from a click, or on the first
 * key press / pointer press) enables it. Playing never throws: when audio is unavailable or still
 * locked, nothing happens.
 */

export type AlertTone = "learner-violation" | "proctor-violation" | "notification";

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

/**
 * Notes (Hz, start offset s, length s) per tone — three distinct, clearly audible patterns:
 * - learner-violation: a firm low-high-low warning (square wave);
 * - proctor-violation: an urgent rising triple beep (square wave), unlike the learner's;
 * - notification: a bright three-note attention chime (triangle wave).
 * Each is under a second and plays once.
 */
const TONES: Record<AlertTone, { freq: number; at: number; len: number; type: OscillatorType }[]> = {
  "learner-violation": [
    { freq: 523, at: 0, len: 0.18, type: "square" },
    { freq: 784, at: 0.22, len: 0.18, type: "square" },
    { freq: 523, at: 0.44, len: 0.26, type: "square" },
  ],
  "proctor-violation": [
    { freq: 880, at: 0, len: 0.12, type: "square" },
    { freq: 988, at: 0.16, len: 0.12, type: "square" },
    { freq: 1175, at: 0.32, len: 0.22, type: "square" },
  ],
  notification: [
    { freq: 784, at: 0, len: 0.16, type: "triangle" },
    { freq: 988, at: 0.15, len: 0.16, type: "triangle" },
    { freq: 1319, at: 0.3, len: 0.38, type: "triangle" },
  ],
};
/**
 * Peak gain per tone (0–1 of full scale), much louder than before (0.05 / 0.08) yet well below
 * clipping: a limiter caps the combined output. The system and browser volume still apply — nothing
 * here can (or tries to) override them.
 */
const VOLUME: Record<AlertTone, number> = { "learner-violation": 0.35, "proctor-violation": 0.35, notification: 0.4 };

let limiter: DynamicsCompressorNode | null = null;
/** A gentle limiter in front of the speakers: loud cues without distortion. */
function output(ctx: AudioContext): AudioNode {
  if (limiter && limiter.context === ctx) return limiter;
  try {
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    limiter.connect(ctx.destination);
    return limiter;
  } catch {
    return ctx.destination;
  }
}

/** Play a tone once (no-op when audio is unavailable or not yet unlocked — visual alerts never depend on it). */
export function playTone(tone: AlertTone) {
  const ctx = audioContext();
  if (!ctx || ctx.state !== "running") return;
  try {
    const start = ctx.currentTime + 0.01;
    const out = output(ctx);
    for (const note of TONES[tone]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = note.type;
      osc.frequency.value = note.freq;
      // A quick fade in and out: no clicks.
      gain.gain.setValueAtTime(0, start + note.at);
      gain.gain.linearRampToValueAtTime(VOLUME[tone], start + note.at + 0.012);
      gain.gain.setValueAtTime(VOLUME[tone], start + note.at + note.len - 0.04);
      gain.gain.linearRampToValueAtTime(0, start + note.at + note.len);
      osc.connect(gain).connect(out);
      osc.start(start + note.at);
      osc.stop(start + note.at + note.len + 0.02);
    }
  } catch {
    // Audio is only a cue.
  }
}
