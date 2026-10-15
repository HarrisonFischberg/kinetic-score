// PLAYGROUND · Geometric Sequencer: a deterministic kinetic sequencer. Every
// moving part is a pure function of time, every note is computed from the
// geometry (a vertex crossing the play line, a pendulum reaching its endpoint,
// a linkage tip crossing the staff line, a Lissajous dot entering the other
// half, an orbit completing a turn) and scheduled ahead on the shared transport.
// With rational period ratios the whole picture and the note pattern repeat
// exactly every loop length L.
import { TAU, clamp } from '../../core/math.ts';
import { lastIndexAtOrBefore } from '../../core/math.ts';
import type { DrawList } from '../../rendering/draw.ts';
import { pitchColor } from '../../rendering/palette.ts';
import { drawSampledTrail } from '../../rendering/effects.ts';
import type { InstrumentId } from '../../audio/instruments.ts';
import { degreeToMidi, rootOptions, scaleOptions } from '../../music/scales.ts';
import { noteName } from '../../music/score.ts';
import type { ParamDef, ParamValue, PerfEvent, PerformanceInfo, Scene, SceneServices } from '../types.ts';

type VoiceId = 'poly' | 'pend' | 'rods' | 'liss' | 'orbit';

interface Frac {
  n: number;
  d: number;
}

const RATIOS: { value: string; label: string; f: Frac }[] = [
  { value: '1/1', label: '1 × base', f: { n: 1, d: 1 } },
  { value: '1/2', label: '½ × base', f: { n: 1, d: 2 } },
  { value: '2/1', label: '2 × base', f: { n: 2, d: 1 } },
  { value: '3/2', label: '3⁄2 × base', f: { n: 3, d: 2 } },
  { value: '2/3', label: '2⁄3 × base', f: { n: 2, d: 3 } },
  { value: '4/3', label: '4⁄3 × base', f: { n: 4, d: 3 } },
  { value: '3/4', label: '3⁄4 × base', f: { n: 3, d: 4 } },
  { value: '5/4', label: '5⁄4 × base', f: { n: 5, d: 4 } },
];

const LISS: Record<string, [number, number]> = { '1:2': [1, 2], '2:3': [2, 3], '3:4': [3, 4], '3:5': [3, 5], '1:3': [1, 3] };

const SETS: Record<string, Record<VoiceId, InstrumentId>> = {
  mallets: { poly: 'marimba', pend: 'bell', rods: 'pluck', liss: 'glass', orbit: 'marimba' },
  bells: { poly: 'glass', pend: 'bell', rods: 'bell', liss: 'glass', orbit: 'glass' },
  arcade: { poly: 'arcade', pend: 'pluck', rods: 'arcade', liss: 'voice', orbit: 'arcade' },
  warm: { poly: 'pluck', pend: 'voice', rods: 'pluck', liss: 'marimba', orbit: 'glass' },
};

const MAPPINGS: Record<string, { label: string; degrees: number[] }> = {
  scale: { label: 'Scale steps', degrees: [0, 1, 2, 3, 4, 5, 6, 7] },
  triad: { label: 'Chord tones', degrees: [0, 2, 4, 7, 9, 11, 14, 16] },
  wide: { label: 'Wide leaps', degrees: [0, 4, 1, 5, 2, 6, 3, 7] },
};

interface SeqEvent extends PerfEvent {
  voice: VoiceId;
  /** index of the triggering part (vertex, endpoint, moon...) */
  part: number;
  x: number;
  y: number;
}

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;

/** least common multiple of rational periods (each n/d) as a fraction */
export function loopMultiple(fracs: Frac[]): Frac {
  let num = 1;
  let den = 0;
  for (const f of fracs) {
    const g = gcd(f.n, f.d);
    const n = f.n / g;
    const d = f.d / g;
    num = lcm(num, n);
    den = den === 0 ? d : gcd(den, d);
  }
  return { n: num, d: den || 1 };
}

const CENTERS: Record<VoiceId, [number, number]> = {
  poly: [-4.6, 4.2],
  pend: [4.6, 7.4],
  rods: [-4.6, -4.4],
  liss: [4.6, -4.4],
  orbit: [0, 0],
};

export class SequencerScene implements Scene {
  readonly info = {
    id: 'sequencer',
    title: 'Geometric Sequencer',
    mode: 'playground' as const,
    blurb: 'Rotating polygons, a pendulum, a two-rod linkage, a Lissajous path and orbiting moons. Geometry decides every note; rational ratios make the loop repeat exactly.',
    motion: 'Deterministic kinetic sequencer · notes computed from the geometry and scheduled on the audio clock',
  };
  values: Record<string, ParamValue> = {
    base: 4,
    phase: 0,
    poly: true,
    polyN: 5,
    polyRatio: '1/1',
    pend: true,
    pendRatio: '1/2',
    rods: true,
    rodsRatio: '2/1',
    rodsK: '3',
    liss: true,
    lissRatio: '2:3',
    lissPeriod: '2/1',
    orbit: true,
    mapping: 'triad',
    set: 'mallets',
    scale: 'majorPent',
    root: '7',
    quantize: 'off',
  };
  readonly params: ParamDef[];
  private svc!: SceneServices;
  private events: SeqEvent[] = [];
  private loopEvents: Record<VoiceId, number[]> = { poly: [], pend: [], rods: [], liss: [], orbit: [] };
  private loopEventsRef: Record<VoiceId, SeqEvent[]> = { poly: [], pend: [], rods: [], liss: [], orbit: [] };
  private L = 8;
  private duration = 600;
  private timelineChanged: () => void = () => {};

  constructor() {
    const on = (k: string) => (v: Record<string, ParamValue>) => v[k] === true;
    const ratioOpts = RATIOS.map((r) => ({ value: r.value, label: r.label }));
    this.params = [
      { key: 'base', label: 'Base period', type: 'range', min: 1.5, max: 8, step: 0.25, unit: 's', applies: 'live', group: 'Timing' },
      { key: 'phase', label: 'Phase offset', type: 'range', min: 0, max: 1, step: 0.01, applies: 'live', group: 'Timing', hint: 'Rotates every part’s starting position (fraction of a turn)' },
      { key: 'quantize', label: 'Quantize', type: 'select', applies: 'live', group: 'Timing', options: [{ value: 'off', label: 'Off (exact geometry)' }, { value: '8', label: '1/8 of base' }, { value: '16', label: '1/16 of base' }], hint: 'Snaps note times (and their flashes) to a grid; motion is unchanged' },
      { key: 'poly', label: 'Rotating polygon', type: 'toggle', applies: 'live', group: 'Parts' },
      { key: 'polyN', label: 'Polygon vertices', type: 'range', min: 3, max: 8, step: 1, applies: 'live', group: 'Parts', visible: on('poly') },
      { key: 'polyRatio', label: 'Polygon period', type: 'select', applies: 'live', group: 'Parts', options: ratioOpts, visible: on('poly') },
      { key: 'pend', label: 'Pendulum', type: 'toggle', applies: 'live', group: 'Parts' },
      { key: 'pendRatio', label: 'Pendulum period', type: 'select', applies: 'live', group: 'Parts', options: ratioOpts, visible: on('pend') },
      { key: 'rods', label: 'Linked rods', type: 'toggle', applies: 'live', group: 'Parts' },
      { key: 'rodsRatio', label: 'Rod period', type: 'select', applies: 'live', group: 'Parts', options: ratioOpts, visible: on('rods') },
      { key: 'rodsK', label: 'Second rod speed', type: 'select', applies: 'live', group: 'Parts', options: ['2', '3', '4', '-2', '-3'].map((v) => ({ value: v, label: `${v}× first rod` })), visible: on('rods') },
      { key: 'liss', label: 'Lissajous path', type: 'toggle', applies: 'live', group: 'Parts' },
      { key: 'lissRatio', label: 'Lissajous ratio', type: 'select', applies: 'live', group: 'Parts', options: Object.keys(LISS).map((k) => ({ value: k, label: k })), visible: on('liss') },
      { key: 'lissPeriod', label: 'Lissajous period', type: 'select', applies: 'live', group: 'Parts', options: ratioOpts, visible: on('liss') },
      { key: 'orbit', label: 'Orbiting moons', type: 'toggle', applies: 'live', group: 'Parts' },
      { key: 'mapping', label: 'Note mapping', type: 'select', applies: 'live', group: 'Sound', options: Object.entries(MAPPINGS).map(([value, m]) => ({ value, label: m.label })) },
      { key: 'set', label: 'Instruments', type: 'select', applies: 'live', group: 'Sound', options: [{ value: 'mallets', label: 'Mallets & bells' }, { value: 'bells', label: 'All bells' }, { value: 'arcade', label: 'Arcade' }, { value: 'warm', label: 'Warm' }] },
      { key: 'scale', label: 'Scale', type: 'select', applies: 'live', group: 'Sound', options: scaleOptions() },
      { key: 'root', label: 'Key', type: 'select', applies: 'live', group: 'Sound', options: rootOptions() },
    ];
  }

  init(svc: SceneServices): void {
    this.svc = svc;
    this.timelineChanged = () => svc.timelineChanged?.();
  }

  reset(): void {
    this.build();
  }

  private ratio(key: string): Frac {
    return (RATIOS.find((r) => r.value === this.values[key]) ?? RATIOS[0]).f;
  }

  private period(key: string): number {
    const f = this.ratio(key);
    return (Number(this.values.base) * f.n) / f.d;
  }

  private enabled(): VoiceId[] {
    return (['poly', 'pend', 'rods', 'liss', 'orbit'] as VoiceId[]).filter((v) => this.values[v] === true);
  }

  /** loop length in seconds: LCM of every enabled part's period */
  loopLength(): number {
    const fr: Frac[] = [];
    const v = this.enabled();
    if (v.includes('poly')) fr.push(this.ratio('polyRatio'));
    // the pendulum swings out and back once per period, so its endpoint pattern repeats every period
    if (v.includes('pend')) fr.push(this.ratio('pendRatio'));
    if (v.includes('rods')) fr.push(this.ratio('rodsRatio'));
    if (v.includes('liss')) fr.push(this.ratio('lissPeriod'));
    if (v.includes('orbit')) fr.push({ n: 1, d: 1 }, { n: 3, d: 2 }, { n: 2, d: 1 });
    if (!fr.length) fr.push({ n: 1, d: 1 });
    const m = loopMultiple(fr);
    return (Number(this.values.base) * m.n) / m.d;
  }

  private pitch(voice: VoiceId, idx: number, octave: number): number {
    const map = MAPPINGS[String(this.values.mapping)] ?? MAPPINGS.scale;
    const d = map.degrees[((idx % map.degrees.length) + map.degrees.length) % map.degrees.length];
    return degreeToMidi(d, Number(this.values.root), String(this.values.scale), octave + (voice === 'pend' ? -1 : 0));
  }

  // ---- geometry (pure functions of t) ----

  private polyAngle(t: number): number {
    return Number(this.values.phase) * TAU + (TAU * t) / this.period('polyRatio');
  }

  private pendAngle(t: number): number {
    return 0.85 * Math.sin((TAU * t) / this.period('pendRatio') + Number(this.values.phase) * TAU);
  }

  private rods(t: number): { jx: number; jy: number; tx: number; ty: number } {
    const [cx, cy] = CENTERS.rods;
    const w1 = TAU / this.period('rodsRatio');
    const k = Number(this.values.rodsK);
    const a1 = w1 * t + Number(this.values.phase) * TAU;
    const a2 = k * w1 * t;
    const jx = cx + Math.cos(a1) * 2.3;
    const jy = cy + Math.sin(a1) * 2.3;
    return { jx, jy, tx: jx + Math.cos(a2) * 1.25, ty: jy + Math.sin(a2) * 1.25 };
  }

  private liss(t: number): { x: number; y: number } {
    const [cx, cy] = CENTERS.liss;
    const [a, b] = LISS[String(this.values.lissRatio)] ?? [2, 3];
    const w = TAU / this.period('lissPeriod');
    return { x: cx + 3 * Math.sin(a * w * t + Math.PI / 2 + Number(this.values.phase) * TAU), y: cy + 3 * Math.sin(b * w * t) };
  }

  private orbitAngle(j: number, t: number): number {
    const P = Number(this.values.base) * [1, 1.5, 2][j];
    return Math.PI / 2 - (TAU * t) / P - Number(this.values.phase) * TAU;
  }

  // ---- event generation ----

  private build(): void {
    const L = this.loopLength();
    this.L = L;
    const set = SETS[String(this.values.set)] ?? SETS.mallets;
    const base = Number(this.values.base);
    const q = this.values.quantize === 'off' ? 0 : base / Number(this.values.quantize);
    const one: SeqEvent[] = [];
    const add = (voice: VoiceId, part: number, t: number, pitch: number, vel: number, x: number, y: number, dur = 0.5) => {
      let tt = q ? Math.round(t / q) * q : t;
      tt = ((tt % L) + L) % L;
      one.push({ time: tt, voice, part, x, y, pan: clamp(x / 8, -0.8, 0.8), target: voice, notes: [{ pitch, vel, dur, inst: set[voice] }] });
    };
    const en = this.enabled();
    if (en.includes('poly')) {
      const N = Number(this.values.polyN);
      const P = this.period('polyRatio');
      const [cx, cy] = CENTERS.poly;
      for (let k = 0; k < N; k++) {
        // vertex k at angle polyAngle(t) + 2πk/N reaches the play line (π/2)
        const a0 = Number(this.values.phase) * TAU + (TAU * k) / N;
        let t0 = (((Math.PI / 2 - a0) % TAU) + TAU) % TAU;
        t0 = (t0 / TAU) * P;
        for (let t = t0; t < L - 1e-9; t += P) add('poly', k, t, this.pitch('poly', k, 4), 0.7, cx, cy + 2.6);
      }
    }
    if (en.includes('pend')) {
      const P = this.period('pendRatio');
      const ph = Number(this.values.phase) * TAU;
      // endpoints where the phase argument = π/2 + mπ
      for (let m = -2; m < (2 * L) / P + 2; m++) {
        const t = ((Math.PI / 2 + m * Math.PI - ph) / TAU) * P;
        if (t < -1e-9 || t >= L - 1e-9) continue;
        const right = Math.sin((TAU * t) / P + ph) > 0;
        const [px, py] = CENTERS.pend;
        const ang = right ? 0.85 : -0.85;
        add('pend', right ? 1 : 0, t, this.pitch('pend', right ? 4 : 0, 4), 0.75, px + Math.sin(ang) * 4.2, py - Math.cos(ang) * 4.2, 1.2);
      }
    }
    if (en.includes('rods')) {
      // tip crossing the staff line (y = centre) upward; pitch from x position
      const [cx, cy] = CENTERS.rods;
      const g = (t: number) => this.rods(t).ty - cy;
      this.scan(L, g, (t) => {
        const r = this.rods(t);
        const idx = Math.round(((r.tx - cx) / 3.55) * 3.5 + 3.5);
        add('rods', idx, t, this.pitch('rods', idx, 4), 0.65, r.tx, r.ty);
      });
    }
    if (en.includes('liss')) {
      const [cx] = CENTERS.liss;
      const g = (t: number) => this.liss(t).x - cx;
      this.scan(L, g, (t, dir) => {
        const p = this.liss(t);
        const idx = Math.round(((p.y - CENTERS.liss[1]) / 3) * 3 + 3) + (dir > 0 ? 0 : 1);
        add('liss', idx, t, this.pitch('liss', idx, 5), 0.6, p.x, p.y, 0.8);
      }, true);
    }
    if (en.includes('orbit')) {
      for (let j = 0; j < 3; j++) {
        const P = base * [1, 1.5, 2][j];
        // completes a turn when the moon passes the top marker (angle π/2)
        let t0 = ((-Number(this.values.phase) * P) % P + P) % P;
        if (t0 < 1e-9) t0 = 0;
        for (let t = t0; t < L - 1e-9; t += P) add('orbit', j, t, this.pitch('orbit', [0, 4, 7][j], 5), 0.55, 0, 0.8 + j * 0.7);
      }
    }
    one.sort((a, b) => a.time - b.time);
    for (const v of Object.keys(this.loopEvents) as VoiceId[]) {
      const list = one.filter((e) => e.voice === v);
      this.loopEventsRef[v] = list;
      this.loopEvents[v] = list.map((e) => e.time);
    }
    // unroll loops for the transport timeline (bounded to ~10 minutes)
    const loops = Math.max(1, Math.ceil(600 / L));
    this.duration = loops * L;
    const all: SeqEvent[] = [];
    for (let i = 0; i < loops; i++) for (const e of one) all.push({ ...e, time: e.time + i * L });
    this.events = all;
  }

  /** find zero crossings of g over [0, L) by sampling then bisection */
  private scan(L: number, g: (t: number) => number, hit: (t: number, dir: number) => void, both = false): void {
    const h = 1 / 400;
    let t0 = 0;
    let g0 = g(0);
    for (let i = 1; i <= Math.ceil(L / h); i++) {
      const t1 = Math.min(L, i * h);
      const g1 = g(t1);
      const up = g0 < 0 && g1 >= 0;
      const down = g0 > 0 && g1 <= 0;
      if (up || (both && down)) {
        let a = t0;
        let b = t1;
        for (let k = 0; k < 30; k++) {
          const m = (a + b) / 2;
          const gm = g(m);
          if ((up && gm < 0) || (down && gm > 0)) a = m;
          else b = m;
        }
        if (b < L - 1e-6) hit(b, up ? 1 : -1);
      }
      t0 = t1;
      g0 = g1;
    }
  }

  update(): void {}

  onParam(): void {
    this.build();
    this.timelineChanged();
  }

  randomize(rand: () => number): void {
    const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
    this.values.polyN = 3 + Math.floor(rand() * 6);
    this.values.polyRatio = pick(['1/1', '1/2', '2/1']);
    this.values.pendRatio = pick(['1/2', '1/1', '3/2']);
    this.values.rodsRatio = pick(['2/1', '1/1', '4/3']);
    this.values.rodsK = pick(['2', '3', '-2', '-3']);
    this.values.lissRatio = pick(Object.keys(LISS));
    this.values.mapping = pick(Object.keys(MAPPINGS));
    this.values.set = pick(Object.keys(SETS));
    this.values.scale = pick(['majorPent', 'minorPent', 'dorian', 'lydian', 'major']);
    this.values.root = String(Math.floor(rand() * 12));
    this.values.phase = Math.round(rand() * 100) / 100;
  }

  performance(): PerformanceInfo {
    return {
      songId: '',
      duration: this.duration,
      events: this.events,
      loop: this.L,
      phraseAt: () => '',
    };
  }

  bounds() {
    return { minX: -9.2, minY: -8.6, maxX: 9.2, maxY: 9.2 };
  }

  private flash(voice: VoiceId, t: number, part?: number): number {
    const L = this.L;
    const tm = ((t % L) + L) % L;
    const times = this.loopEvents[voice];
    const refs = this.loopEventsRef[voice];
    let i = lastIndexAtOrBefore(times, tm);
    let best = 0;
    // look back over a few events (and across the loop seam)
    for (let k = 0; k < 6; k++, i--) {
      const idx = ((i % times.length) + times.length) % times.length;
      if (!times.length) break;
      let dtv = tm - times[idx];
      if (i < 0) dtv += L;
      if (dtv > 0.6) break;
      if (part !== undefined && refs[idx].part !== part) continue;
      best = Math.max(best, Math.exp(-dtv / 0.16));
    }
    return best;
  }

  render(dl: DrawList, t: number): void {
    const pal = this.svc.palette();
    const app = this.svc.appearance();
    const en = this.enabled();
    const lbl = app.noteLabels;
    const hl = app.highlights ? 1 : 0;
    if (en.includes('poly')) {
      const [cx, cy] = CENTERS.poly;
      const N = Number(this.values.polyN);
      const a = this.polyAngle(t);
      const R = 2.6;
      const f = this.flash('poly', t) * hl;
      dl.line(cx, cy, cx, cy + R + 0.9, 0.03 + f * 0.03, pal.accent, 0.6 + f * 0.4, 0.1 + f * 0.3);
      dl.ring(cx, cy, R, 0.02, pal.grid, 0.6);
      for (let k = 0; k < N; k++) {
        const a1 = a + (TAU * k) / N;
        const a2 = a + (TAU * (k + 1)) / N;
        dl.line(cx + Math.cos(a1) * R, cy + Math.sin(a1) * R, cx + Math.cos(a2) * R, cy + Math.sin(a2) * R, 0.06, pal.track, 0.9, 0.1);
      }
      for (let k = 0; k < N; k++) {
        const a1 = a + (TAU * k) / N;
        const p = this.pitch('poly', k, 4);
        const fk = this.flash('poly', t, k) * hl;
        const c = pitchColor(pal, p);
        dl.disc(cx + Math.cos(a1) * R, cy + Math.sin(a1) * R, 0.2 + fk * 0.12, c, 1);
        if (fk > 0.05) dl.glow(cx + Math.cos(a1) * R, cy + Math.sin(a1) * R, 1.2, c, fk * 0.7);
        if (lbl) dl.text(noteName(p, false), cx + Math.cos(a1) * (R - 0.55), cy + Math.sin(a1) * (R - 0.55), 0.24, pal.text, 0.6, 'center');
      }
      dl.disc(cx, cy, 0.12, pal.structure, 0.9);
    }
    if (en.includes('pend')) {
      const [px, py] = CENTERS.pend;
      const ang = this.pendAngle(t);
      const Lp = 4.2;
      const bx = px + Math.sin(ang) * Lp;
      const by = py - Math.cos(ang) * Lp;
      dl.arc(px, py, Lp, 0.015, -Math.PI / 2 - 0.95, 1.9, pal.grid, 0.7);
      for (const side of [0, 1]) {
        const sa = side ? 0.85 : -0.85;
        const p = this.pitch('pend', side ? 4 : 0, 4);
        const f = this.flash('pend', t, side) * hl;
        const c = pitchColor(pal, p);
        const ex = px + Math.sin(sa) * (Lp + 0.55);
        const ey = py - Math.cos(sa) * (Lp + 0.55);
        dl.disc(ex, ey, 0.32 + f * 0.1, c, 0.35 + f * 0.5);
        dl.ring(ex, ey, 0.32, 0.04, c, 1, 0.1 + f * 0.3);
        if (f > 0.05) dl.glow(ex, ey, 1.4, c, f * 0.7);
        if (lbl) dl.text(noteName(p), ex, ey - 0.62, 0.24, pal.text, 0.6, 'center');
      }
      dl.line(px, py, bx, by, 0.04, pal.structure, 0.9);
      dl.disc(px, py, 0.1, pal.structure, 1);
      drawSampledTrail(dl, (tt) => ({ x: px + Math.sin(this.pendAngle(tt)) * Lp, y: py - Math.cos(this.pendAngle(tt)) * Lp, visible: true }), t, app.trails ? app.trailLength : 0, 0.3, pal.voices.bass, 14);
      dl.ball(bx, by, 0.32, pal.voices.bass, 1, ang * 3, this.flash('pend', t) * hl);
    }
    if (en.includes('rods')) {
      const [cx, cy] = CENTERS.rods;
      dl.line(cx - 3.8, cy, cx + 3.8, cy, 0.02, pal.accent, 0.5, 0.06);
      // staff ticks: pitch zones along the line
      for (let i = 0; i <= 7; i++) {
        const x = cx + ((i - 3.5) / 3.5) * 3.55;
        dl.line(x, cy - 0.12, x, cy + 0.12, 0.015, pal.dim, 0.5);
      }
      // faint full curve of the tip
      const P = this.period('rodsRatio');
      let prev = this.rods(0);
      for (let i = 1; i <= 160; i++) {
        const r = this.rods((i / 160) * P);
        dl.line(prev.tx, prev.ty, r.tx, r.ty, 0.012, pal.grid, 0.8);
        prev = r;
      }
      const r = this.rods(t);
      drawSampledTrail(dl, (tt) => {
        const q = this.rods(tt);
        return { x: q.tx, y: q.ty, visible: true };
      }, t, app.trails ? app.trailLength * 1.5 : 0, 0.22, pal.voices.counter, 20);
      dl.line(cx, cy, r.jx, r.jy, 0.07, pal.structure, 0.9, 0.05);
      dl.line(r.jx, r.jy, r.tx, r.ty, 0.05, pal.track, 0.9, 0.08);
      dl.disc(cx, cy, 0.14, pal.structure, 1);
      dl.disc(r.jx, r.jy, 0.1, pal.text, 0.9);
      const f = this.flash('rods', t) * hl;
      dl.ball(r.tx, r.ty, 0.2, pal.voices.counter, 1, 0, f);
      const evs = this.loopEventsRef.rods;
      if (f > 0.05 && evs.length) {
        const i = lastIndexAtOrBefore(this.loopEvents.rods, ((t % this.L) + this.L) % this.L);
        const e = evs[(i + evs.length) % evs.length];
        dl.glow(e.x, cy, 1.1, pitchColor(pal, e.notes[0].pitch), f * 0.8);
        if (lbl) dl.text(noteName(e.notes[0].pitch), e.x, cy - 0.45, 0.26, pal.text, f, 'center');
      }
    }
    if (en.includes('liss')) {
      const [cx, cy] = CENTERS.liss;
      const P = this.period('lissPeriod');
      dl.line(cx, cy - 3.4, cx, cy + 3.4, 0.02, pal.accent, 0.5, 0.06);
      let prev = this.liss(0);
      for (let i = 1; i <= 200; i++) {
        const p = this.liss((i / 200) * P);
        dl.line(prev.x, prev.y, p.x, p.y, 0.014, pal.grid, 0.9);
        prev = p;
      }
      const p = this.liss(t);
      drawSampledTrail(dl, (tt) => ({ ...this.liss(tt), visible: true }), t, app.trails ? app.trailLength * 1.5 : 0, 0.2, pal.voices.accomp, 20);
      const f = this.flash('liss', t) * hl;
      dl.ball(p.x, p.y, 0.2, pal.voices.accomp, 1, 0, f);
      if (f > 0.05) dl.glow(cx, p.y, 1.2, pal.voices.accomp, f * 0.6);
    }
    if (en.includes('orbit')) {
      for (let j = 0; j < 3; j++) {
        const R = 0.8 + j * 0.7;
        const a = this.orbitAngle(j, t);
        const p = this.pitch('orbit', [0, 4, 7][j], 5);
        const f = this.flash('orbit', t, j) * hl;
        const c = pitchColor(pal, p);
        dl.ring(0, 0, R, 0.015, pal.grid, 0.9);
        dl.line(0, R - 0.15, 0, R + 0.15, 0.03, c, 0.6 + f * 0.4, 0.05 + f * 0.2);
        dl.ball(Math.cos(a) * R, Math.sin(a) * R, 0.16, c, 1, 0, f);
        if (f > 0.05) dl.glow(0, R, 0.9, c, f * 0.6);
      }
      dl.disc(0, 0, 0.18, pal.accent, 0.8);
    }
  }

  hud(dl: DrawList, t: number, aspect: number): void {
    const pal = this.svc.palette();
    const L = this.L;
    const k = ((t % L) + L) % L / L;
    const w = 0.5;
    const x0 = aspect - 0.07 - w;
    dl.rect(x0 + w / 2, -0.9, w / 2, 0.008, 0, pal.grid, 0.8, 0, 0, 0, 'hud');
    dl.rect(x0 + (w * k) / 2, -0.9, (w * k) / 2, 0.008, 0, pal.accent, 0.9, 0, 0, 0, 'hud');
    dl.text(`loop ${L.toFixed(2)} s`, x0 + w, -0.86, 0.035, pal.dim, 0.9, 'right', 'hud');
  }

  stats(): [string, string][] {
    const per = this.loopEventsRef;
    const n = (Object.keys(per) as VoiceId[]).reduce((s, v) => s + per[v].length, 0);
    return [
      ['Loop', `${this.L.toFixed(2)}s`],
      ['Notes/loop', String(n)],
      ['Parts', String(this.enabled().length)],
    ];
  }

  loopInfo(): string {
    return `Seamless AV loop of ${this.L.toFixed(2)} s: every position and every note repeat exactly (rational period ratios). Ringing tails cross the seam, so for a loopable file use the “One seamless loop” take, which records the second cycle.`;
  }

  dispose(): void {}
}
