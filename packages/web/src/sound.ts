/**
 * Interface sounds, synthesised rather than sampled.
 *
 * Two reasons. The dashboard is served off a LAN box with no CDN, so every
 * asset is a byte the operator has to host; and a four-note blip built from
 * oscillators is a few hundred bytes of code against a few tens of kilobytes of
 * audio file. It also means the palette is tunable in one place instead of in
 * an audio editor.
 *
 * Autoplay policy, which is where sound in a web app normally dies:
 *
 *   - Every browser starts an AudioContext suspended until a real user gesture
 *     resumes it. On iOS Safari a later `.play()` from a socket callback fails
 *     silently — no error, no sound, no clue. So the context is resumed from
 *     the first pointer or key event on the page, not at the moment a sound is
 *     wanted.
 *   - A backgrounded tab suspends audio and throttles timers to roughly one
 *     tick a minute. Sound-on-new-message therefore *cannot* fire while
 *     backgrounded, on any platform. That path is notifications' job, not this
 *     module's — see notify.ts.
 */
import type { Prefs } from './store.js';

export type SoundName = 'message' | 'mention' | 'send' | 'approval' | 'alert';

type Ctor = typeof AudioContext;

let context: AudioContext | null = null;
let unlocked = false;

function audioContext(): AudioContext | null {
  if (context) return context;
  const Ctx: Ctor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
  if (!Ctx) return null;
  context = new Ctx();
  return context;
}

/**
 * Resume audio from a user gesture.
 *
 * Called from a one-shot listener on the first interaction with the page. The
 * silent buffer is the part that actually unlocks iOS: resuming the context
 * alone is not always enough, playing something through it is.
 */
export function unlockAudio(): void {
  if (unlocked) return;
  const ctx = audioContext();
  if (!ctx) return;
  unlocked = true;
  void ctx.resume().catch(() => {});
  try {
    const buffer = ctx.createBuffer(1, 1, 22_050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    /* an unlock that fails leaves us exactly where we were */
  }
}

/** Wire the unlock to the first gesture. Safe to call more than once. */
export function installAudioUnlock(): () => void {
  const handler = (): void => unlockAudio();
  const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart'];
  for (const event of events) window.addEventListener(event, handler, { once: true, passive: true });
  return () => {
    for (const event of events) window.removeEventListener(event, handler);
  };
}

interface Tone {
  /** Frequency in Hz. */
  hz: number;
  /** Seconds from the start of the sound. */
  at: number;
  /** Seconds the note rings for. */
  dur: number;
  gain: number;
  type?: OscillatorType;
}

/**
 * The palette.
 *
 * Pitched to sit above a room's noise floor without being shrill, and kept
 * short — anything past ~250ms in a chat app becomes the thing you remember
 * about the product. Mention and approval rise; alert falls, because a falling
 * interval is what everything else in the world uses for "something is wrong".
 */
const SOUNDS: Record<SoundName, { tones: Tone[]; gain: number }> = {
  message: {
    gain: 0.22,
    tones: [
      { hz: 587.33, at: 0, dur: 0.08, gain: 0.6 },
      { hz: 880, at: 0.055, dur: 0.1, gain: 0.5 },
    ],
  },
  mention: {
    gain: 0.3,
    tones: [
      { hz: 659.25, at: 0, dur: 0.09, gain: 0.6 },
      { hz: 987.77, at: 0.07, dur: 0.09, gain: 0.55 },
      { hz: 1318.51, at: 0.14, dur: 0.14, gain: 0.45 },
    ],
  },
  send: {
    gain: 0.14,
    tones: [{ hz: 1174.66, at: 0, dur: 0.05, gain: 0.5, type: 'triangle' }],
  },
  approval: {
    gain: 0.3,
    tones: [
      { hz: 784, at: 0, dur: 0.1, gain: 0.6 },
      { hz: 784, at: 0.16, dur: 0.1, gain: 0.6 },
      { hz: 1046.5, at: 0.32, dur: 0.16, gain: 0.5 },
    ],
  },
  alert: {
    gain: 0.34,
    tones: [
      { hz: 466.16, at: 0, dur: 0.16, gain: 0.7, type: 'sawtooth' },
      { hz: 349.23, at: 0.17, dur: 0.24, gain: 0.6, type: 'sawtooth' },
    ],
  },
};

/** Rate limit so a burst of ten messages is one blip, not ten. */
const MIN_GAP_MS = 220;
let lastPlayedAt = 0;

/**
 * `urgent` is the one thing do-not-disturb does not silence. An approval blocks
 * an agent until the operator answers it, so a quiet mode that hides it turns a
 * paused fleet into a mystery. Chat can wait; a blocked machine cannot.
 */
export function play(name: SoundName, prefs: Prefs, options: { urgent?: boolean } = {}): void {
  if (!prefs.sound) return;
  if (prefs.doNotDisturb && !options.urgent) return;

  const now = Date.now();
  if (now - lastPlayedAt < MIN_GAP_MS) return;

  const ctx = audioContext();
  if (!ctx || ctx.state === 'suspended') return; // not unlocked yet; stay silent
  lastPlayedAt = now;

  const spec = SOUNDS[name];
  const master = ctx.createGain();
  master.gain.value = spec.gain;
  master.connect(ctx.destination);

  for (const tone of spec.tones) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = tone.type ?? 'sine';
    osc.frequency.value = tone.hz;

    // A raw gate on a sine is a click at both ends; the ramps are the whole
    // difference between "notification" and "pop".
    const start = ctx.currentTime + tone.at;
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(tone.gain, start + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, start + tone.dur);

    osc.connect(env);
    env.connect(master);
    osc.start(start);
    osc.stop(start + tone.dur + 0.02);
  }
}

/** Preview one sound from the settings UI, ignoring the rate limit. */
export function preview(name: SoundName): void {
  unlockAudio();
  lastPlayedAt = 0;
  play(name, {
    sound: true,
    notifications: false,
    doNotDisturb: false,
    mutedChannels: [],
    showArchived: false,
  });
}
