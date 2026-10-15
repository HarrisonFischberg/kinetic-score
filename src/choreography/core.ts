// Choreography primitives for PERFORMANCE scenes.
//
// Everything here is a pure function of performance time t, so playback is
// deterministic, pausing/seeking/recording can never desynchronise, and the
// same note list drives both the audio events and the visible activations.
// Motion is hybrid choreographed physics: balls follow real ballistic arcs
// (constant gravity) between contacts, guided rails and timed releases — the
// arcs are solved backwards from the score so every contact lands on its note.
import type { RGB } from '../rendering/draw.ts';
import type { VoiceRole } from '../music/score.ts';
import type { PerfNote } from '../scenes/types.ts';
import { clamp, lastIndexAtOrBefore } from '../core/math.ts';

export interface Pt {
  x: number;
  y: number;
}

export type Ease = 'linear' | 'inOut' | 'in' | 'out';

export function ease(e: Ease, u: number): number {
  u = clamp(u, 0, 1);
  switch (e) {
    case 'inOut':
      return u * u * (3 - 2 * u);
    case 'in':
      return u * u;
    case 'out':
      return 1 - (1 - u) * (1 - u);
    default:
      return u;
  }
}

/** Polyline with cumulative arc length, sampled by distance. */
export class Path {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly cum: Float64Array;
  readonly length: number;

  constructor(points: Pt[]) {
    const n = points.length;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.cum = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      this.xs[i] = points[i].x;
      this.ys[i] = points[i].y;
      if (i > 0) acc += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      this.cum[i] = acc;
    }
    this.length = acc;
  }

  at(s: number, out: Pt = { x: 0, y: 0 }): Pt {
    const n = this.xs.length;
    if (s <= 0 || n < 2) {
      out.x = this.xs[0];
      out.y = this.ys[0];
      return out;
    }
    if (s >= this.length) {
      out.x = this.xs[n - 1];
      out.y = this.ys[n - 1];
      return out;
    }
    let i = lastIndexAtOrBefore(this.cum, s);
    if (i >= n - 1) i = n - 2;
    const seg = this.cum[i + 1] - this.cum[i] || 1;
    const u = (s - this.cum[i]) / seg;
    out.x = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * u;
    out.y = this.ys[i] + (this.ys[i + 1] - this.ys[i]) * u;
    return out;
  }

  /** arc length of the vertex nearest to a point (used to place gates on a route) */
  nearestS(p: Pt): number {
    let best = Infinity;
    let bs = 0;
    for (let i = 0; i < this.xs.length; i++) {
      const d = (this.xs[i] - p.x) ** 2 + (this.ys[i] - p.y) ** 2;
      if (d < best) {
        best = d;
        bs = this.cum[i];
      }
    }
    return bs;
  }
}

export type Segment =
  | { kind: 'hold'; t0: number; t1: number; x: number; y: number }
  | { kind: 'flight'; t0: number; t1: number; x0: number; y0: number; vx: number; vy: number; g: number }
  | { kind: 'path'; t0: number; t1: number; path: Path; s0: number; s1: number; ease: Ease }
  | { kind: 'knots'; t0: number; t1: number; path: Path; ts: number[]; ss: number[] }
  | { kind: 'fn'; t0: number; t1: number; f: (t: number, out: Pt) => Pt };

export interface BallActor {
  id: string;
  r: number;
  /** colour override; by default balls take their voice colour from the palette */
  color?: RGB;
  voice: VoiceRole;
  segs: Segment[];
  /** shown from segs[0].t0 to the end of the last segment */
  fadeIn: number;
  fadeOut: number;
  /** optional depth curve: (t) → 0 (front) … 1 (behind the machine) */
  depth?: (t: number) => number;
  /** times at which this ball makes a sounding contact (for its flash) */
  hits: number[];
}

export interface Sample {
  x: number;
  y: number;
  visible: boolean;
  alpha: number;
  scale: number;
}

const tmpPt: Pt = { x: 0, y: 0 };

export function segPos(s: Segment, t: number, out: Pt): Pt {
  switch (s.kind) {
    case 'hold':
      out.x = s.x;
      out.y = s.y;
      return out;
    case 'flight': {
      const dt = clamp(t, s.t0, s.t1) - s.t0;
      out.x = s.x0 + s.vx * dt;
      out.y = s.y0 + s.vy * dt - 0.5 * s.g * dt * dt;
      return out;
    }
    case 'path': {
      const u = s.t1 > s.t0 ? (clamp(t, s.t0, s.t1) - s.t0) / (s.t1 - s.t0) : 1;
      return s.path.at(s.s0 + (s.s1 - s.s0) * ease(s.ease, u), out);
    }
    case 'knots': {
      // monotone piecewise-linear arc length through (ts, ss): constant speed between knots
      const tt = clamp(t, s.t0, s.t1);
      let i = lastIndexAtOrBefore(s.ts, tt);
      if (i < 0) i = 0;
      if (i >= s.ts.length - 1) return s.path.at(s.ss[s.ss.length - 1], out);
      const u = (tt - s.ts[i]) / (s.ts[i + 1] - s.ts[i] || 1);
      return s.path.at(s.ss[i] + (s.ss[i + 1] - s.ss[i]) * u, out);
    }
    case 'fn':
      return s.f(clamp(t, s.t0, s.t1), out);
  }
}

export function actorStart(a: BallActor): number {
  return a.segs[0].t0;
}

export function actorEnd(a: BallActor): number {
  return a.segs[a.segs.length - 1].t1;
}

export function sampleActor(a: BallActor, t: number, out: Sample): Sample {
  const t0 = actorStart(a);
  const t1 = actorEnd(a);
  if (t < t0 || t > t1) {
    out.visible = false;
    return out;
  }
  let seg = a.segs[a.segs.length - 1];
  for (const s of a.segs) {
    if (t <= s.t1) {
      seg = s;
      break;
    }
  }
  segPos(seg, t, tmpPt);
  out.x = tmpPt.x;
  out.y = tmpPt.y;
  out.visible = true;
  const fi = a.fadeIn > 0 ? clamp((t - t0) / a.fadeIn, 0, 1) : 1;
  const fo = a.fadeOut > 0 ? clamp((t1 - t) / a.fadeOut, 0, 1) : 1;
  const d = a.depth ? a.depth(t) : 0;
  out.alpha = Math.min(fi, fo) * (1 - d * 0.55);
  out.scale = 1 - d * 0.4;
  return out;
}

/** Ballistic segment through p0 at t0 and p1 at t1 under gravity g (downward). */
export function flightBetween(t0: number, p0: Pt, t1: number, p1: Pt, g: number): Extract<Segment, { kind: 'flight' }> {
  const T = Math.max(1e-4, t1 - t0);
  return { kind: 'flight', t0, t1, x0: p0.x, y0: p0.y, vx: (p1.x - p0.x) / T, vy: (p1.y - p0.y) / T + 0.5 * g * T, g };
}

export function flightVelAt(s: Extract<Segment, { kind: 'flight' }>, t: number): Pt {
  return { x: s.vx, y: s.vy - s.g * (t - s.t0) };
}

/** Apex height above the start of a flight segment (for reachability checks). */
export function flightApex(s: Extract<Segment, { kind: 'flight' }>): number {
  if (s.vy <= 0) return s.y0;
  const ta = Math.min(s.vy / s.g, s.t1 - s.t0);
  return s.y0 + s.vy * ta - 0.5 * s.g * ta * ta;
}

export interface Activation {
  time: number;
  /** prop that visibly produces the sound */
  target: string;
  notes: PerfNote[];
  x: number;
  y: number;
  /** contact normal (for particle direction) */
  nx: number;
  ny: number;
  voice: VoiceRole;
  /** actor that strikes it, if any */
  ball?: string;
  /** label (note names) */
  label: string;
}

export interface DrawCtx {
  /** 0..1 decaying flash for a prop at time t */
  flash(target: string, t: number, decay?: number): number;
  /** time since the most recent activation of the target (Infinity if none) */
  since(target: string, t: number): number;
  /** next activation time of a target after t (Infinity if none) */
  next(target: string, t: number): number;
  labels: boolean;
  highlights: boolean;
}

/** Index of activation times per target for fast flash lookup. */
export class ActivationIndex {
  private map = new Map<string, number[]>();

  constructor(acts: Activation[]) {
    for (const a of acts) {
      const arr = this.map.get(a.target) ?? [];
      arr.push(a.time);
      this.map.set(a.target, arr);
    }
    for (const arr of this.map.values()) arr.sort((a, b) => a - b);
  }

  since(target: string, t: number): number {
    const arr = this.map.get(target);
    if (!arr) return Infinity;
    const i = lastIndexAtOrBefore(arr, t);
    return i < 0 ? Infinity : t - arr[i];
  }

  next(target: string, t: number): number {
    const arr = this.map.get(target);
    if (!arr) return Infinity;
    const i = lastIndexAtOrBefore(arr, t);
    return i + 1 < arr.length ? arr[i + 1] : Infinity;
  }

  times(target: string): number[] {
    return this.map.get(target) ?? [];
  }
}

/** deterministic hash → [0,1) for stateless particle effects */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ validation

export interface ValidationReport {
  ok: boolean;
  problems: string[];
  maxSpeed: number;
  maxJump: number;
}

/**
 * Checks a choreography for teleports (position jumps between consecutive
 * samples), excessive speed, segment discontinuities and that every ball that
 * strikes an activation is actually at the activation point at that time.
 */
export function validateChoreography(balls: BallActor[], acts: Activation[], opts: { maxSpeed: number; contactTol: number; dt?: number }): ValidationReport {
  const problems: string[] = [];
  const dt = opts.dt ?? 1 / 240;
  let maxSpeed = 0;
  let maxJump = 0;
  const s: Sample = { x: 0, y: 0, visible: false, alpha: 1, scale: 1 };
  const p: Pt = { x: 0, y: 0 };
  const q: Pt = { x: 0, y: 0 };
  for (const a of balls) {
    for (let i = 1; i < a.segs.length; i++) {
      const prev = a.segs[i - 1];
      const cur = a.segs[i];
      if (Math.abs(prev.t1 - cur.t0) > 1e-6) problems.push(`${a.id}: time gap between segments ${i - 1} and ${i}`);
      segPos(prev, prev.t1, p);
      segPos(cur, cur.t0, q);
      const jump = Math.hypot(p.x - q.x, p.y - q.y);
      if (jump > 1e-3) problems.push(`${a.id}: position jump ${jump.toFixed(4)} between segments ${i - 1} and ${i}`);
    }
    const t0 = actorStart(a);
    const t1 = actorEnd(a);
    let px = NaN;
    let py = NaN;
    for (let t = t0; t <= t1; t += dt) {
      sampleActor(a, t, s);
      if (!Number.isNaN(px)) {
        const d = Math.hypot(s.x - px, s.y - py);
        maxJump = Math.max(maxJump, d);
        maxSpeed = Math.max(maxSpeed, d / dt);
      }
      px = s.x;
      py = s.y;
    }
    if (problems.length > 30) break;
  }
  if (maxSpeed > opts.maxSpeed) problems.push(`max speed ${maxSpeed.toFixed(1)} exceeds ${opts.maxSpeed}`);
  const byId = new Map(balls.map((b) => [b.id, b] as const));
  for (const act of acts) {
    if (!act.ball) continue;
    const b = byId.get(act.ball);
    if (!b) {
      problems.push(`activation at ${act.time.toFixed(3)} references missing ball ${act.ball}`);
      continue;
    }
    sampleActor(b, act.time, s);
    if (!s.visible) {
      problems.push(`${b.id} is not visible at its activation ${act.time.toFixed(3)}`);
      continue;
    }
    const d = Math.hypot(s.x - act.x, s.y - act.y);
    if (d > b.r + opts.contactTol) problems.push(`${b.id} is ${d.toFixed(3)} from ${act.target} at ${act.time.toFixed(3)}`);
  }
  return { ok: problems.length === 0, problems, maxSpeed, maxJump };
}
