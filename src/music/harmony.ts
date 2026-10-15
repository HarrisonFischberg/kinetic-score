// Harmony guide for free-physics scenes. Collisions happen whenever they happen,
// so raw contact pitches clash; the guide keeps every hit inside a slowly
// changing chord, optionally makes each hit continue the line from the previous
// one, and thins out pile-ups of simultaneous notes. Pure logic (no audio), so it
// is unit-testable and deterministic for a given sequence of (pitch, time) calls.
import { SCALES } from './scales.ts';
import type { ParamDef } from '../scenes/types.ts';

export type HarmonyMode = 'off' | 'chords' | 'melody';

/** chord roots as degrees (0-based) of the 7-note parent scale */
export const PROGRESSIONS: Record<string, { label: string; major: number[]; minor: number[] }> = {
  bright: { label: 'Bright (I–V–vi–IV)', major: [0, 4, 5, 3], minor: [0, 5, 2, 6] },
  calm: { label: 'Calm (I–IV–I–V)', major: [0, 3, 0, 4], minor: [0, 3, 0, 4] },
  dreamy: { label: 'Dreamy (I–vi–IV–V)', major: [0, 5, 3, 4], minor: [0, 5, 3, 6] },
  drone: { label: 'One chord (no changes)', major: [0], minor: [0] },
};

/** pentatonic and modal scales borrow their chords from a 7-note parent scale */
const PARENT: Record<string, string> = {
  majorPent: 'major',
  minorPent: 'minor',
  major: 'major',
  minor: 'minor',
  dorian: 'dorian',
  lydian: 'lydian',
  harmonicMinor: 'harmonicMinor',
};

const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export interface HarmonyConfig {
  mode: HarmonyMode;
  root: number;
  scale: string;
  progression: string;
  /** seconds each chord lasts */
  chordSeconds: number;
  /** most notes allowed to start within `window` seconds (extra hits stay silent) */
  maxBurst: number;
  window: number;
  low: number;
  high: number;
  /** melody mode: largest jump (semitones) from the previous note */
  maxLeap: number;
}

export function defaultHarmony(): HarmonyConfig {
  return { mode: 'melody', root: 2, scale: 'majorPent', progression: 'bright', chordSeconds: 4, maxBurst: 3, window: 0.12, low: 55, high: 86, maxLeap: 7 };
}

export interface Chord {
  /** pitch classes of the chord tones that belong to the scale */
  pcs: number[];
  name: string;
}

export function chordAt(cfg: Pick<HarmonyConfig, 'root' | 'scale' | 'progression' | 'chordSeconds'>, t: number): Chord {
  const scaleSteps = (SCALES[cfg.scale] ?? SCALES.majorPent).steps;
  const scalePcs = scaleSteps.map((s) => (s + cfg.root) % 12);
  const parentId = PARENT[cfg.scale];
  if (!parentId) {
    // whole tone / chromatic: no functional chords; the scale itself is the palette
    return { pcs: scalePcs, name: `${NAMES[cfg.root]} ${(SCALES[cfg.scale] ?? SCALES.majorPent).label.toLowerCase()}` };
  }
  const parent = SCALES[parentId].steps;
  const prog = PROGRESSIONS[cfg.progression] ?? PROGRESSIONS.bright;
  const roots = parent[2] === 4 ? prog.major : prog.minor;
  const idx = Math.floor(Math.max(0, t) / Math.max(0.25, cfg.chordSeconds)) % roots.length;
  const deg = roots[idx];
  const triad = [0, 2, 4].map((k) => (parent[(deg + k) % 7] + cfg.root) % 12);
  // keep the scale's character: drop chord tones outside it (pentatonic), unless too few remain
  const inScale = triad.filter((pc) => scalePcs.includes(pc));
  const pcs = inScale.length >= 2 ? inScale : triad;
  const third = (triad[1] - triad[0] + 12) % 12;
  const fifth = (triad[2] - triad[0] + 12) % 12;
  const quality = third === 3 ? (fifth === 6 ? 'dim' : 'm') : fifth === 8 ? '+' : '';
  return { pcs, name: NAMES[triad[0]] + quality };
}

/** all pitches in [low, high] whose pitch class is in pcs, ascending */
function candidates(pcs: number[], low: number, high: number): number[] {
  const out: number[] = [];
  for (let p = low; p <= high; p++) if (pcs.includes(((p % 12) + 12) % 12)) out.push(p);
  return out;
}

function nearest(list: number[], p: number): number {
  let best = list[0];
  for (const c of list) if (Math.abs(c - p) < Math.abs(best - p)) best = c;
  return best;
}

export class Harmonizer {
  cfg: HarmonyConfig;
  private last: number | null = null;
  private lastTime = -Infinity;
  private recent: { t: number; p: number }[] = [];
  suppressed = 0;

  constructor(cfg: Partial<HarmonyConfig> = {}) {
    this.cfg = { ...defaultHarmony(), ...cfg };
  }

  reset(): void {
    this.last = null;
    this.lastTime = -Infinity;
    this.recent = [];
    this.suppressed = 0;
  }

  chord(t: number): Chord {
    return chordAt(this.cfg, t);
  }

  /**
   * Map a requested pitch at scene time t to the pitch to play, or null when the
   * hit should stay silent (too many notes at once). In 'off' mode the pitch is
   * returned unchanged and nothing is thinned.
   */
  pitch(requested: number, t: number): number | null {
    const c = this.cfg;
    if (c.mode === 'off') return requested;
    this.recent = this.recent.filter((r) => t - r.t < c.window && t >= r.t);
    if (this.recent.length >= c.maxBurst) {
      this.suppressed++;
      return null;
    }
    const pool = candidates(this.chord(t).pcs, c.low, c.high);
    // fold the request into range by octaves so it still points the right way
    let want = requested;
    while (want < c.low) want += 12;
    while (want > c.high) want -= 12;
    let out: number;
    if (c.mode === 'melody' && this.last !== null && t - this.lastTime < 2.5) {
      // continue the line: a chord tone close to the previous note, leaning toward the request
      const prev = this.last;
      const near = pool.filter((p) => p !== prev && Math.abs(p - prev) <= c.maxLeap);
      const opts = near.length ? near : pool;
      out = opts[0];
      for (const o of opts) {
        const d = Math.abs(o - want) - Math.abs(out - want);
        if (d < 0 || (d === 0 && Math.abs(o - prev) < Math.abs(out - prev))) out = o;
      }
    } else {
      out = nearest(pool, want);
    }
    // two notes landing together: never the same pitch twice (it just sounds like a flam)
    if (this.recent.some((r) => r.p === out)) {
      this.suppressed++;
      return null;
    }
    this.recent.push({ t, p: out });
    this.last = out;
    this.lastTime = t;
    return out;
  }

  /** the k-th chord tone above `base` (for pads set to play chords) */
  above(base: number, k: number, t: number): number {
    if (this.cfg.mode === 'off') return base;
    const pool = candidates(this.chord(t).pcs, base + 1, base + 24);
    return pool[Math.min(k - 1, pool.length - 1)] ?? base;
  }

  /** gentler velocity when several notes are already sounding together */
  velocity(v: number): number {
    if (this.cfg.mode === 'off') return v;
    return v / Math.sqrt(1 + Math.max(0, this.recent.length - 1) * 0.5);
  }
}

/** Scene controls shared by the free-physics scenes. */
export function harmonyParams(group: string): ParamDef[] {
  const on = (v: Record<string, unknown>) => v.harmony !== 'off';
  return [
    {
      key: 'harmony',
      label: 'Harmony guide',
      type: 'select',
      applies: 'live',
      group,
      options: [
        { value: 'melody', label: 'Melody — each hit follows the last' },
        { value: 'chords', label: 'Chords — hits stay in the chord' },
        { value: 'off', label: 'Off — raw pitches' },
      ],
      hint: 'Keeps random collisions musical: notes follow a chord progression, and in Melody mode each hit moves a small step from the previous note',
    },
    { key: 'progression', label: 'Chord progression', type: 'select', applies: 'live', group, visible: on, options: Object.entries(PROGRESSIONS).map(([value, p]) => ({ value, label: p.label })) },
    { key: 'chordSeconds', label: 'Chord change every', type: 'range', min: 1, max: 12, step: 0.5, unit: 's', applies: 'live', group, visible: on },
    { key: 'maxBurst', label: 'Notes allowed at once', type: 'range', min: 1, max: 8, step: 1, applies: 'live', group, visible: on, hint: 'Hits beyond this within ~0.1 s stay silent (still visible), so pile-ups do not turn into noise' },
  ];
}

export const HARMONY_DEFAULTS = { harmony: 'melody', progression: 'bright', chordSeconds: 4, maxBurst: 3 };

/** copy the scene's current control values into a harmonizer */
export function applyHarmonyValues(h: Harmonizer, v: Record<string, unknown>): void {
  h.cfg.mode = v.harmony === 'off' || v.harmony === 'chords' ? v.harmony : 'melody';
  h.cfg.progression = typeof v.progression === 'string' && v.progression in PROGRESSIONS ? v.progression : 'bright';
  h.cfg.chordSeconds = Number(v.chordSeconds) || 4;
  h.cfg.maxBurst = Math.max(1, Math.round(Number(v.maxBurst) || 3));
  h.cfg.root = Number(v.root) || 0;
  h.cfg.scale = String(v.scale ?? 'majorPent');
}
