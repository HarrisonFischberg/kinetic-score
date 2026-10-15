// Reusable kinetic mechanisms. Each builder takes the notes it must play and a
// placement, and emits ball actors, visible props and sounding activations into
// a shared MachineBuilder. All motion is solved backwards from note times.
import { TAU, clamp, lastIndexAtOrBefore } from '../core/math.ts';
import { noteName, type TimedNote, type VoiceRole } from '../music/score.ts';
import type { DrawList, RGB } from '../rendering/draw.ts';
import type { Prop, PropCtx, Voicing } from '../scenes/performance/perfScene.ts';
import { Path, flightBetween, flightVelAt, type Activation, type BallActor, type Pt, type Segment } from './core.ts';

export interface MachineBuilder {
  balls: BallActor[];
  props: Prop[];
  acts: Activation[];
  voicing: Voicing;
  /** reachability / plausibility problems found while building */
  problems: string[];
}

export function newBuilder(voicing: Voicing): MachineBuilder {
  return { balls: [], props: [], acts: [], voicing, problems: [] };
}

export interface NoteGroup {
  time: number;
  notes: TimedNote[];
  top: number;
}

export function groupNotes(notes: TimedNote[], eps = 0.012): NoteGroup[] {
  const out: NoteGroup[] = [];
  for (const n of [...notes].sort((a, b) => a.time - b.time || a.pitch - b.pitch)) {
    const g = out[out.length - 1];
    if (g && n.time - g.time <= eps) {
      g.notes.push(n);
      g.top = Math.max(g.top, n.pitch);
    } else out.push({ time: n.time, notes: [n], top: n.pitch });
  }
  return out;
}

function label(g: NoteGroup): string {
  return g.notes.map((n) => noteName(n.pitch)).join('·');
}

function act(b: MachineBuilder, g: NoteGroup, target: string, x: number, y: number, nx: number, ny: number, voice: VoiceRole, ball?: string): void {
  b.acts.push({
    time: g.time,
    target,
    notes: g.notes.map((n) => ({ pitch: n.pitch, vel: n.vel, dur: n.dur, inst: b.voicing[n.voice] })),
    x,
    y,
    nx,
    ny,
    voice,
    ball,
    label: label(g),
  });
}

/** angle of a direction, normalised to (-π, π] */
const ang = (x: number, y: number) => Math.atan2(y, x);

// ------------------------------------------------------------------ hopper (release gate)

export function hopperProp(id: string, p: Pt, release: number[], r: number, voice: VoiceRole): Prop {
  return {
    id,
    draw(dl: DrawList, t: number, c: PropCtx) {
      const col = c.voiceColor(voice);
      const w = r * 2.4;
      dl.line(p.x - w * 1.6, p.y + w * 1.8, p.x - w * 0.55, p.y - r * 1.1, 0.06, c.pal.structure, 0.9, 0.05);
      dl.line(p.x + w * 1.6, p.y + w * 1.8, p.x + w * 0.55, p.y - r * 1.1, 0.06, c.pal.structure, 0.9, 0.05);
      // gate flap opens around each release
      const k = lastIndexAtOrBefore(release, t);
      const since = k >= 0 ? t - release[k] : Infinity;
      const open = since < 0.35 ? Math.sin((since / 0.35) * Math.PI) : 0;
      const a = -open * 1.3;
      const hx = p.x - w * 0.55;
      const hy = p.y - r * 1.1;
      dl.line(hx, hy, hx + Math.cos(a) * w * 1.1, hy + Math.sin(a) * w * 1.1, 0.05, col, 0.9, 0.1 + open * 0.3);
      dl.disc(hx, hy, 0.07, c.pal.text, 0.8);
    },
  };
}

// ------------------------------------------------------------------ bounce chain (chime stairs, pegboard)

export interface BounceChainOpts {
  id: string;
  voice: VoiceRole;
  r: number;
  g: number;
  /** where the ball waits (in a hopper) before its release */
  start: Pt;
  /** contact point (ball centre at impact) for group k */
  layout: (k: number, g: NoteGroup, count: number) => Pt;
  style: 'stair' | 'peg' | 'chime';
  padHalf: number;
  /** drain point the ball flies to after its last note, and how long it takes */
  exit: Pt;
  exitDur: number;
  /** first flight duration from the hopper */
  dropTime: number;
  /** gaps longer than this make the ball rest on its pad and get kicked later */
  maxHop: number;
  visibleFrom?: number;
}

export function bounceChain(b: MachineBuilder, notes: TimedNote[], oIn: BounceChainOpts): { releaseTime: number } {
  const groups = groupNotes(notes);
  if (!groups.length) return { releaseTime: 0 };
  // fast passages get snappier gravity so each hop can still travel (g = 0 → automatic)
  const iois = groups.slice(1).map((g, i) => g.time - groups[i].time).sort((a, b) => a - b);
  const q = iois.length ? iois[Math.floor(iois.length * 0.25)] : 0.5;
  const o: BounceChainOpts = { ...oIn, g: oIn.g > 0 ? oIn.g : clamp(1.7 / (q * q), 10, 30) };
  const pts = groups.map((g, k) => o.layout(k, g, groups.length));
  // keep every contact a genuine bounce: each hop must leave upward and land downward, with
  // vertical speed at least matching sideways speed (so incoming·outgoing ≤ 0 at every pad).
  // With h = gT²/2 that means |dx| + |dy| ≤ h (approximately): split the budget between them.
  for (let k = 1; k < pts.length; k++) {
    const T = groups[k].time - groups[k - 1].time;
    if (T > o.maxHop) continue;
    const h = (o.g * T * T) / 2;
    const dx = clamp(pts[k].x - pts[k - 1].x, -0.62 * h, 0.62 * h);
    const dyMax = Math.max(0, h * 0.92 - 1.05 * Math.abs(dx));
    const dy = clamp(pts[k].y - pts[k - 1].y, -dyMax, dyMax);
    pts[k] = { x: pts[k - 1].x + dx, y: pts[k - 1].y + dy };
  }
  const segs: Segment[] = [];
  const release = groups[0].time - o.dropTime;
  const ballId = `${o.id}:ball`;
  segs.push({ kind: 'hold', t0: o.visibleFrom ?? 0, t1: release, x: o.start.x, y: o.start.y });
  segs.push(flightBetween(release, o.start, groups[0].time, pts[0], o.g));
  const rests: { k: number; until: number }[] = [];
  for (let k = 0; k < groups.length - 1; k++) {
    const t0 = groups[k].time;
    const t1 = groups[k + 1].time;
    if (t1 - t0 > o.maxHop) {
      const hop = Math.min(o.maxHop, 0.75);
      segs.push({ kind: 'hold', t0, t1: t1 - hop, x: pts[k].x, y: pts[k].y });
      segs.push(flightBetween(t1 - hop, pts[k], t1, pts[k + 1], o.g));
      rests.push({ k, until: t1 - hop });
    } else segs.push(flightBetween(t0, pts[k], t1, pts[k + 1], o.g));
  }
  const tl = groups[groups.length - 1].time;
  const lastPt = pts[pts.length - 1];
  // leave the last pad upward with vertical speed ≥ sideways speed
  const need = Math.abs(o.exit.x - lastPt.x) - (o.exit.y - lastPt.y);
  const exitDur = Math.max(o.exitDur, Math.sqrt((2 * Math.max(0, need)) / o.g) * 1.1 + 0.08);
  segs.push(flightBetween(tl, lastPt, tl + exitDur, o.exit, o.g));
  b.balls.push({ id: ballId, r: o.r, voice: o.voice, segs, fadeIn: 0.25, fadeOut: 0.18, hits: groups.map((g) => g.time) });
  // derive each pad's orientation from the incoming and outgoing velocities (mirror normal)
  const flights = segs.filter((s): s is Extract<Segment, { kind: 'flight' }> => s.kind === 'flight');
  const restAt = new Set(rests.map((r) => r.k));
  groups.forEach((g, k) => {
    const inSeg = flights.find((s) => Math.abs(s.t1 - g.time) < 1e-9)!;
    const vin = flightVelAt(inSeg, g.time);
    let vout: Pt = { x: 0, y: 0 };
    if (!restAt.has(k)) {
      const outSeg = flights.find((s) => Math.abs(s.t0 - g.time) < 1e-9);
      if (outSeg) vout = flightVelAt(outSeg, g.time);
    }
    let nx = vout.x - vin.x;
    let ny = vout.y - vin.y;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    // must be a genuine bounce: approaching before, leaving after
    if (vin.x * nx + vin.y * ny > -1e-6) b.problems.push(`${o.id}: pad ${k} is not approached by the ball`);
    if (!restAt.has(k) && vout.x * nx + vout.y * ny < 1e-6) b.problems.push(`${o.id}: ball does not leave pad ${k}`);
    const p = pts[k];
    const padTh = o.style === 'peg' ? 0.11 : 0.07;
    const cx = p.x - nx * (o.r + padTh);
    const cy = p.y - ny * (o.r + padTh);
    const target = `${o.id}:pad${k}`;
    const tilt = ang(nx, ny) - Math.PI / 2;
    const kick = rests.find((r) => r.k === k);
    act(b, g, target, p.x - nx * o.r, p.y - ny * o.r, nx, ny, o.voice, ballId);
    b.props.push({
      id: target,
      draw(dl: DrawList, t: number, c: PropCtx) {
        const col = c.voiceColor(o.voice);
        const f = c.flash(target, t);
        const upcoming = t < g.time && g.time - t < 2.5 ? 1 - (g.time - t) / 2.5 : 0;
        const kicked = kick && t >= kick.until ? Math.max(0, 1 - (t - kick.until) / 0.2) : 0;
        if (o.style === 'peg') {
          dl.disc(cx, cy, padTh + 0.04 + f * 0.05, col, 0.55 + f * 0.45 + upcoming * 0.2);
          dl.ring(cx, cy, padTh + 0.04, 0.02, col, 1, 0.08 + f * 0.3);
        } else {
          const ux = Math.cos(tilt) * o.padHalf;
          const uy = Math.sin(tilt) * o.padHalf;
          const d = -f * 0.05 + kicked * 0.08;
          dl.line(cx - ux + nx * d, cy - uy + ny * d, cx + ux + nx * d, cy + uy + ny * d, padTh, col, 0.9, 0.08 + f * 0.35 + upcoming * 0.1, 'main', 1);
          if (o.style === 'stair') dl.line(cx - ux, cy - uy - 0.04, cx - ux, cy - uy - 0.55, 0.025, c.pal.structure, 0.5);
        }
        if (f > 0.03) dl.glow(cx, cy, o.padHalf * 2.4 + 0.3, col, f * 0.5);
        if (c.labels && (upcoming > 0 || f > 0.05)) dl.text(label(g), cx + nx * 0.02, cy - 0.32, 0.2, c.pal.text, Math.max(f, upcoming * 0.6), 'center');
      },
    });
  });
  // drain mouth
  b.props.push({
    id: `${o.id}:drain`,
    draw(dl: DrawList, _t: number, c: PropCtx) {
      dl.ring(o.exit.x, o.exit.y, o.r * 1.9, 0.05, c.pal.structure, 0.7);
      dl.disc(o.exit.x, o.exit.y, o.r * 1.7, c.pal.bgBottom, 0.9);
    },
  });
  b.props.push(hopperProp(`${o.id}:hopper`, o.start, [release], o.r, o.voice));
  return { releaseTime: release };
}

// ------------------------------------------------------------------ path ride (guided spiral, funnel, branching lane)

export interface PathRideOpts {
  id: string;
  voice: VoiceRole;
  r: number;
  path: Path;
  /** arc length where gates may start/end (the rest is entry run-up / exit run-out) */
  gateFrom: number;
  gateTo: number;
  style: 'gate' | 'chime';
  /** extra visual for the track */
  trackWidth: number;
  /** draw track behind (true) — for helices the caller may draw its own track */
  drawTrack: boolean;
  visibleFrom?: number;
  holdAtEnd?: boolean;
  /** motion before the ride, given the time the ride starts and its start point (must end there) */
  pre?: (rideStart: number, start: Pt) => Segment[];
}

export function pathRide(b: MachineBuilder, notes: TimedNote[], o: PathRideOpts): { start: number; speed: number; t0: number; gateFrom: number; gateEnd: number } {
  const groups = groupNotes(notes);
  if (!groups.length) return { start: 0, speed: 0, t0: 0, gateFrom: 0, gateEnd: 0 };
  const t0 = groups[0].time;
  const tN = groups[groups.length - 1].time;
  const span = Math.max(0.001, tN - t0);
  const usable = o.gateTo - o.gateFrom;
  // constant speed through the gates; capped so short passages do not make the marble streak
  const v = groups.length > 1 ? Math.min(usable / span, 9) : 2.5;
  const gateEnd = o.gateFrom + v * (groups.length > 1 ? span : 0);
  const sOf = (t: number) => o.gateFrom + (t - t0) * v;
  // entry: accelerate from rest at s=0 so that speed reaches v exactly at the first gate
  const entryDur = o.gateFrom > 0 ? (2 * o.gateFrom) / v : 0;
  const tr = t0 - entryDur;
  const exitLen = o.path.length - gateEnd;
  const exitDur = exitLen > 0 ? exitLen / Math.max(v, 3.5) : 0;
  const ballId = `${o.id}:ball`;
  const p0 = o.path.at(0);
  const segs: Segment[] = [];
  const preSegs = o.pre?.(tr, p0) ?? [];
  if (preSegs.length) {
    segs.push(...preSegs);
    const lastPre = preSegs[preSegs.length - 1].t1;
    if (lastPre > tr + 1e-6) b.problems.push(`${o.id}: arrives at the track after its first note window`);
    segs.push({ kind: 'hold', t0: lastPre, t1: Math.max(lastPre, tr), x: p0.x, y: p0.y });
  } else segs.push({ kind: 'hold', t0: o.visibleFrom ?? 0, t1: tr, x: p0.x, y: p0.y });
  if (entryDur > 0) segs.push({ kind: 'path', t0: tr, t1: t0, path: o.path, s0: 0, s1: o.gateFrom, ease: 'in' });
  const ts = groups.map((g) => g.time);
  const ss = ts.map(sOf);
  if (groups.length > 1) segs.push({ kind: 'knots', t0, t1: tN, path: o.path, ts, ss });
  else segs.push({ kind: 'hold', t0, t1: t0 + 0.001, x: o.path.at(o.gateFrom).x, y: o.path.at(o.gateFrom).y });
  const tEnd = (groups.length > 1 ? tN : t0 + 0.001) + exitDur;
  if (exitDur > 0) segs.push({ kind: 'path', t0: groups.length > 1 ? tN : t0 + 0.001, t1: tEnd, path: o.path, s0: gateEnd, s1: o.path.length, ease: 'linear' });
  if (o.holdAtEnd) {
    const e = o.path.at(o.path.length);
    segs.push({ kind: 'hold', t0: tEnd, t1: tEnd + 3, x: e.x, y: e.y });
  }
  b.balls.push({ id: ballId, r: o.r, voice: o.voice, segs, fadeIn: 0.25, fadeOut: o.holdAtEnd ? 0.5 : 0.25, hits: ts });
  if (o.drawTrack) {
    const P = o.path;
    b.props.push({
      id: `${o.id}:track`,
      draw(dl: DrawList, _t: number, c: PropCtx) {
        const col = c.voiceColor(o.voice);
        for (let i = 1; i < P.xs.length; i++) dl.line(P.xs[i - 1], P.ys[i - 1], P.xs[i], P.ys[i], o.trackWidth, mixDim(col, c.pal.structure), 0.55, 0.04);
      },
    });
  }
  groups.forEach((g, k) => {
    const s = ss[k];
    const p = o.path.at(s);
    const a = o.path.at(Math.max(0, s - 0.05));
    const q = o.path.at(Math.min(o.path.length, s + 0.05));
    let tx = q.x - a.x;
    let ty = q.y - a.y;
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    const nx = -ty;
    const ny = tx;
    const target = `${o.id}:gate${k}`;
    act(b, g, target, p.x, p.y, nx, ny, o.voice, ballId);
    const half = o.r * 1.9;
    b.props.push({
      id: target,
      draw(dl: DrawList, t: number, c: PropCtx) {
        const col = c.voiceColor(o.voice);
        const f = c.flash(target, t);
        const upcoming = t < g.time && g.time - t < 2 ? 1 - (g.time - t) / 2 : 0;
        // only gates near "now" are drawn strongly; the rest stay as faint marks
        const near = t > g.time - 3 && t < g.time + 1.2 ? 1 : 0.18;
        if (near < 1 && f < 0.02) {
          dl.disc(p.x, p.y, 0.035, col, 0.35);
          return;
        }
        if (o.style === 'gate') {
          dl.disc(p.x + nx * half, p.y + ny * half, 0.06, col, 0.9);
          dl.disc(p.x - nx * half, p.y - ny * half, 0.06, col, 0.9);
          dl.line(p.x - nx * half, p.y - ny * half, p.x + nx * half, p.y + ny * half, 0.018 + f * 0.04, col, 0.35 + upcoming * 0.4 + f * 0.6, 0.06 + f * 0.25);
        } else {
          dl.line(p.x + nx * (o.r + 0.05), p.y + ny * (o.r + 0.05), p.x + nx * (o.r + 0.45), p.y + ny * (o.r + 0.45), 0.05 + f * 0.03, col, 0.6 + f * 0.4, 0.06 + f * 0.25);
        }
        if (f > 0.03) dl.glow(p.x, p.y, 0.8, col, f * 0.55);
        if (c.labels && (f > 0.05 || upcoming > 0.5)) dl.text(label(g), p.x + nx * (half + 0.3), p.y + ny * (half + 0.3), 0.18, c.pal.text, Math.max(f, (upcoming - 0.5) * 1.2), 'center');
      },
    });
  });
  return { start: tr, speed: v, t0, gateFrom: o.gateFrom, gateEnd };
}

function mixDim(a: RGB, b: RGB): RGB {
  return [a[0] * 0.35 + b[0] * 0.65, a[1] * 0.35 + b[1] * 0.65, a[2] * 0.35 + b[2] * 0.65];
}

// ------------------------------------------------------------------ rotary bell hammer (carillon)

export interface StrikerOpts {
  id: string;
  voice: VoiceRole;
  pivot: Pt;
  radius: number;
  from: number;
  to: number;
  bellR: number;
}

export function rotaryHammer(b: MachineBuilder, notes: TimedNote[], o: StrikerOpts): void {
  const groups = groupNotes(notes);
  if (!groups.length) return;
  const pitches = [...new Set(notes.map((n) => n.pitch))].sort((a, b) => a - b);
  const angleOf = new Map<number, number>();
  pitches.forEach((p, i) => angleOf.set(p, pitches.length === 1 ? (o.from + o.to) / 2 : o.from + ((o.to - o.from) * i) / (pitches.length - 1)));
  const times = groups.map((g) => g.time);
  const angles = groups.map((g) => angleOf.get(g.top)!);
  const headR = 0.16;
  const restLen = o.radius - o.bellR - headR - 0.55;
  const hitLen = o.radius - o.bellR - headR;
  const angleAt = (t: number): number => {
    let i = lastIndexAtOrBefore(times, t);
    if (i < 0) return angles[0];
    if (i >= times.length - 1) return angles[angles.length - 1];
    const a0 = angles[i];
    const a1 = angles[i + 1];
    const dt = times[i + 1] - times[i];
    const u = clamp((t - times[i] - dt * 0.18) / (dt * 0.64), 0, 1);
    return a0 + (a1 - a0) * (u * u * (3 - 2 * u));
  };
  const extAt = (t: number): number => {
    const i = lastIndexAtOrBefore(times, t + 0.12);
    if (i < 0) return 0;
    const d = t - times[i];
    if (d < -0.12 || d > 0.2) return 0;
    return d <= 0 ? 1 - Math.pow(-d / 0.12, 2) : 1 - d / 0.2;
  };
  // chords on one rotary arm: a linking bar joins the bells of a chord so one strike rings them together
  groups.forEach((g) => {
    const a = angleOf.get(g.top)!;
    const target = `${o.id}:bell${g.top}`;
    act(b, g, target, o.pivot.x + Math.cos(a) * (o.radius - o.bellR), o.pivot.y + Math.sin(a) * (o.radius - o.bellR), -Math.cos(a), -Math.sin(a), o.voice);
  });
  for (const p of pitches) {
    const a = angleOf.get(p)!;
    const target = `${o.id}:bell${p}`;
    const bx = o.pivot.x + Math.cos(a) * o.radius;
    const by = o.pivot.y + Math.sin(a) * o.radius;
    const size = o.bellR * (1.15 - (pitches.indexOf(p) / Math.max(1, pitches.length - 1)) * 0.35);
    b.props.push({
      id: target,
      draw(dl: DrawList, t: number, c: PropCtx) {
        const col = c.voiceColor(o.voice);
        const f = c.flash(target, t, 0.35);
        const wob = f * 0.08 * Math.sin(t * 40);
        dl.line(bx, by, o.pivot.x + Math.cos(a) * (o.radius + 0.9), o.pivot.y + Math.sin(a) * (o.radius + 0.9), 0.03, c.pal.structure, 0.6);
        dl.disc(bx + wob, by, size, col, 0.3 + f * 0.5);
        dl.ring(bx + wob, by, size, 0.06, col, 1, 0.12 + f * 0.4);
        dl.disc(bx + wob, by - size * 0.55, size * 0.25, col, 0.8);
        if (f > 0.03) dl.glow(bx, by, size * 3.5, col, f * 0.6);
        if (c.labels) dl.text(noteName(p), o.pivot.x + Math.cos(a) * (o.radius + 1.25), o.pivot.y + Math.sin(a) * (o.radius + 1.25), 0.24, c.pal.text, 0.55 + f * 0.45, 'center');
      },
    });
  }
  b.props.push({
    id: `${o.id}:arm`,
    draw(dl: DrawList, t: number, c: PropCtx) {
      const a = angleAt(t);
      const e = extAt(t);
      const len = restLen + (hitLen - restLen) * e;
      const hx = o.pivot.x + Math.cos(a) * len;
      const hy = o.pivot.y + Math.sin(a) * len;
      dl.arc(o.pivot.x, o.pivot.y, o.radius - o.bellR - 0.35, 0.02, o.from - 0.15, o.to - o.from + 0.3, c.pal.grid, 0.7);
      dl.line(o.pivot.x, o.pivot.y, o.pivot.x + Math.cos(a) * restLen * 0.8, o.pivot.y + Math.sin(a) * restLen * 0.8, 0.12, c.pal.structure, 0.95, 0.05);
      dl.line(o.pivot.x + Math.cos(a) * restLen * 0.6, o.pivot.y + Math.sin(a) * restLen * 0.6, hx, hy, 0.05, c.pal.text, 0.8);
      dl.disc(hx, hy, headR, c.voiceColor(o.voice), 1);
      dl.disc(o.pivot.x, o.pivot.y, 0.28, c.pal.structure, 1);
      dl.ring(o.pivot.x, o.pivot.y, 0.28, 0.04, c.pal.text, 0.6);
    },
  });
}

// ------------------------------------------------------------------ pendulum hammers

export interface PendulumOpts {
  id: string;
  voice: VoiceRole;
  x0: number;
  x1: number;
  pivotY: number;
  length: number;
}

export function pendulumRow(b: MachineBuilder, notes: TimedNote[], o: PendulumOpts): void {
  if (!notes.length) return;
  const pitches = [...new Set(notes.map((n) => n.pitch))].sort((a, b) => a - b);
  const groups = groupNotes(notes);
  const bobR = 0.22;
  const bellR = 0.32;
  pitches.forEach((p, i) => {
    const x = pitches.length === 1 ? (o.x0 + o.x1) / 2 : o.x0 + ((o.x1 - o.x0) * i) / (pitches.length - 1);
    const strikes = groups.filter((g) => g.notes.some((n) => n.pitch === p)).map((g) => g.time);
    const len = o.length * (1 - (i / Math.max(1, pitches.length - 1)) * 0.3);
    const bx = x + bobR + bellR;
    const by = o.pivotY - len;
    const target = `${o.id}:bell${p}`;
    for (const g of groups) if (g.notes.some((n) => n.pitch === p)) act(b, { time: g.time, notes: g.notes.filter((n) => n.pitch === p), top: p }, target, bx - bellR, by, -1, 0, o.voice);
    const A = 0.75;
    const angleAt = (t: number): number => {
      const k = lastIndexAtOrBefore(strikes, t + 10);
      // find the strike whose wind-up window contains t
      let phi = 0;
      for (let j = Math.max(0, k - 1); j <= Math.min(strikes.length - 1, k + 1); j++) {
        const ts = strikes[j];
        const prev = j > 0 ? strikes[j - 1] : -Infinity;
        const D = Math.min(0.6, (ts - prev) * 0.85);
        if (t >= ts - D && t <= ts) {
          const u = (t - (ts - D)) / D;
          phi = -A * Math.sin(Math.PI * u) * (D / 0.6);
        } else if (t > ts && t < ts + 0.22) {
          phi = -0.12 * Math.sin((Math.PI * (t - ts)) / 0.22);
        }
      }
      return phi;
    };
    b.props.push({
      id: target,
      draw(dl: DrawList, t: number, c: PropCtx) {
        const col = c.voiceColor(o.voice);
        const f = c.flash(target, t, 0.3);
        const phi = angleAt(t);
        const px = x + Math.sin(phi) * len;
        const py = o.pivotY - Math.cos(phi) * len;
        dl.line(x - 0.3, o.pivotY, x + 0.3, o.pivotY, 0.05, c.pal.structure, 0.8);
        dl.line(x, o.pivotY, px, py, 0.03, c.pal.text, 0.75);
        dl.disc(px, py, bobR, c.pal.structure, 1);
        dl.ring(px, py, bobR, 0.04, col, 0.9);
        const wob = f * 0.05 * Math.sin(t * 50);
        dl.disc(bx + wob, by, bellR, col, 0.28 + f * 0.5);
        dl.ring(bx + wob, by, bellR, 0.05, col, 1, 0.12 + f * 0.35);
        dl.line(bx, by + bellR, bx, o.pivotY, 0.02, c.pal.structure, 0.5);
        if (f > 0.03) dl.glow(bx, by, 1.2, col, f * 0.6);
        if (c.labels) dl.text(noteName(p), bx, by - bellR - 0.3, 0.22, c.pal.text, 0.55 + f * 0.45, 'center');
      },
    });
  });
}

// ------------------------------------------------------------------ pin wheel (paddle wheel / music box)

export interface PinWheelOpts {
  id: string;
  voice: VoiceRole;
  center: Pt;
  radius: number;
  /** world angle of the comb */
  combAngle: number;
  /** wheel is visible (spinning) from this time */
  from: number;
}

export function pinWheel(b: MachineBuilder, notes: TimedNote[], o: PinWheelOpts): void {
  const groups = groupNotes(notes);
  if (!groups.length) return;
  const pitches = [...new Set(notes.map((n) => n.pitch))].sort((a, b) => a - b);
  const rOf = new Map<number, number>();
  pitches.forEach((p, i) => rOf.set(p, o.radius * (0.38 + (0.55 * (i + 0.5)) / pitches.length)));
  const tFirst = groups[0].time;
  const span = Math.max(0.5, groups[groups.length - 1].time - tFirst + 0.6);
  const omega = Math.max(0.25, (TAU * 0.9) / span);
  if (omega * span > TAU) b.problems.push(`${o.id}: pins overlap a full revolution`);
  const wheelAngle = (t: number) => o.combAngle - omega * (t - tFirst);
  const pins: { a: number; r: number; t: number; p: number }[] = [];
  for (const g of groups) for (const n of g.notes) pins.push({ a: omega * (g.time - tFirst), r: rOf.get(n.pitch)!, t: g.time, p: n.pitch });
  for (const g of groups) {
    const ca = Math.cos(o.combAngle);
    const sa = Math.sin(o.combAngle);
    const r = rOf.get(g.top)!;
    act(b, g, `${o.id}:comb${g.top}`, o.center.x + ca * r, o.center.y + sa * r, -sa, ca, o.voice);
  }
  b.props.push({
    id: `${o.id}:wheel`,
    draw(dl: DrawList, t: number, c: PropCtx) {
      const col = c.voiceColor(o.voice);
      const W = wheelAngle(t);
      const { x, y } = o.center;
      dl.disc(x, y, o.radius, c.pal.bgTop, 0.6);
      dl.ring(x, y, o.radius, 0.08, c.pal.structure, 0.95, 0.06);
      for (let k = 0; k < 8; k++) {
        const a = W + (k * TAU) / 8;
        dl.line(x, y, x + Math.cos(a) * o.radius, y + Math.sin(a) * o.radius, 0.04, c.pal.structure, 0.55);
        // paddles on the rim
        const px = x + Math.cos(a) * o.radius;
        const py = y + Math.sin(a) * o.radius;
        dl.line(px, py, px + Math.cos(a) * 0.45, py + Math.sin(a) * 0.45, 0.09, c.pal.structure, 0.85);
      }
      for (const r of new Set(rOf.values())) dl.ring(x, y, r, 0.01, c.pal.grid, 0.8);
      for (const pin of pins) {
        const a = pin.a + W;
        const played = t >= pin.t;
        dl.disc(x + Math.cos(a) * pin.r, y + Math.sin(a) * pin.r, 0.09, played ? c.pal.dim : col, played ? 0.5 : 1);
      }
      dl.disc(x, y, 0.3, c.pal.structure, 1);
    },
  });
  for (const p of pitches) {
    const r = rOf.get(p)!;
    const target = `${o.id}:comb${p}`;
    const ca = Math.cos(o.combAngle);
    const sa = Math.sin(o.combAngle);
    b.props.push({
      id: target,
      layer: 'front',
      draw(dl: DrawList, t: number, c: PropCtx) {
        const col = c.voiceColor(o.voice);
        const f = c.flash(target, t, 0.3);
        const vib = f * 0.12 * Math.sin(t * 60);
        const x = o.center.x + ca * r;
        const y = o.center.y + sa * r;
        // tine sits just ahead of the pin track; it flicks as a pin passes
        const tx = -sa;
        const ty = ca;
        dl.line(x + tx * 0.1 + ca * vib, y + ty * 0.1 + sa * vib, x + tx * 0.75, y + ty * 0.75, 0.022 + f * 0.015, col, 0.55 + f * 0.45, f * 0.3);
        if (f > 0.03) dl.glow(x, y, 0.6, col, f * 0.6);
        if (c.labels && f > 0.05) dl.text(noteName(p), x + tx * 1.1, y + ty * 1.1, 0.2, c.pal.text, f, 'center');
      },
    });
  }
}

// ------------------------------------------------------------------ drip hopper (rain lanes)

export interface DripOpts {
  id: string;
  voice: VoiceRole;
  x0: number;
  x1: number;
  topY: number;
  padY: number;
  fall: number;
}

export function dripHopper(b: MachineBuilder, notes: TimedNote[], o: DripOpts): void {
  if (!notes.length) return;
  const pitches = [...new Set(notes.map((n) => n.pitch))].sort((a, b) => a - b);
  const sp = (o.x1 - o.x0) / Math.max(1, pitches.length);
  const r = clamp(sp * 0.3, 0.1, 0.2);
  const half = clamp(sp * 0.38, 0.12, 0.4);
  const xOf = (p: number) => o.x0 + sp * (pitches.indexOf(p) + 0.5);
  const releases = new Map<number, number[]>();
  notes.forEach((n, i) => {
    const x = xOf(n.pitch);
    const hitY = o.padY + 0.07 + r;
    const g0 = (2 * (o.topY - hitY)) / (o.fall * o.fall);
    const t0 = n.time - o.fall;
    const fall = flightBetween(t0, { x, y: o.topY }, n.time, { x, y: hitY }, g0);
    const side = pitches.indexOf(n.pitch) % 2 ? 1 : -1;
    const out: Segment = { kind: 'flight', t0: n.time, t1: n.time + 0.55, x0: x, y0: hitY, vx: side * 0.8, vy: g0 * o.fall * 0.28, g: g0 };
    const T = n.time;
    b.balls.push({ id: `${o.id}:b${i}`, r, voice: n.voice, segs: [{ kind: 'hold', t0: t0 - 0.2, t1: t0, x, y: o.topY }, fall, out], fadeIn: 0.18, fadeOut: 0.3, depth: (t) => clamp((t - T) / 0.4, 0, 1), hits: [T] });
    act(b, { time: n.time, notes: [n], top: n.pitch }, `${o.id}:pad${n.pitch}`, x, o.padY + 0.07, 0, 1, o.voice, `${o.id}:b${i}`);
    const arr = releases.get(n.pitch) ?? [];
    arr.push(t0);
    releases.set(n.pitch, arr);
  });
  b.props.push({
    id: `${o.id}:rail`,
    draw(dl: DrawList, _t: number, c: PropCtx) {
      dl.rect((o.x0 + o.x1) / 2, o.topY + 0.35, (o.x1 - o.x0) / 2 + 0.2, 0.28, 0, c.pal.structure, 0.25, 0.2);
      dl.line(o.x0 - 0.2, o.topY + 0.07, o.x1 + 0.2, o.topY + 0.07, 0.04, c.pal.structure, 0.8);
    },
  });
  for (const p of pitches) {
    const x = xOf(p);
    const target = `${o.id}:pad${p}`;
    const rel = releases.get(p) ?? [];
    b.props.push({
      id: target,
      draw(dl: DrawList, t: number, c: PropCtx) {
        const col = c.voiceColor(o.voice);
        const f = c.flash(target, t);
        const k = lastIndexAtOrBefore(rel, t);
        const since = k >= 0 ? t - rel[k] : Infinity;
        if (since < o.fall) dl.line(x, o.topY - 0.1, x, o.padY + 0.3, 0.012, col, 0.2);
        dl.line(x - half, o.padY - f * 0.05, x + half, o.padY - f * 0.05, 0.07, col, 0.95, 0.1 + f * 0.35);
        dl.line(x, o.padY - 0.1, x, o.padY - 0.8, 0.02, c.pal.structure, 0.4);
        if (f > 0.03) dl.glow(x, o.padY, half * 3, col, f * 0.5);
        if (c.labels) dl.text(noteName(p), x, o.padY - 0.35, 0.18, c.pal.text, 0.45 + f * 0.5, 'center');
      },
    });
  }
}

// ------------------------------------------------------------------ seesaw launcher (silent structural)

export interface SeesawOpts {
  id: string;
  pivot: Pt;
  half: number;
  /** the messenger ball lands on the left end at this time */
  tipTime: number;
  messengerFrom: Pt;
  messengerDrop: number;
  g: number;
  voice: VoiceRole;
}

/** A messenger marble drops onto the seesaw; the seesaw tips. Returns the right-end position over time. */
export function seesaw(b: MachineBuilder, o: SeesawOpts): { endAt: (t: number) => Pt; tilt: (t: number) => number } {
  const tiltMax = 0.42;
  const tilt = (t: number) => {
    const u = clamp((t - o.tipTime) / 0.22, 0, 1);
    return tiltMax - 2 * tiltMax * (u * u * (3 - 2 * u));
  };
  // left end is down at rest (tilt>0 means right end up? we define angle of the beam)
  const endAt = (t: number): Pt => {
    const a = tilt(t);
    return { x: o.pivot.x + Math.cos(a) * o.half, y: o.pivot.y - Math.sin(a) * o.half };
  };
  const leftAt = (t: number): Pt => {
    const a = tilt(t);
    return { x: o.pivot.x - Math.cos(a) * o.half, y: o.pivot.y + Math.sin(a) * o.half };
  };
  const r = 0.2;
  const land = leftAt(o.tipTime);
  const landPt = { x: land.x + 0.25, y: land.y + r + 0.06 };
  const t0 = o.tipTime - o.messengerDrop;
  const after: Segment = {
    kind: 'fn',
    t0: o.tipTime,
    t1: o.tipTime + 4,
    f: (t, out) => {
      const l = leftAt(t);
      out.x = l.x + 0.25;
      out.y = l.y + r + 0.06;
      return out;
    },
  };
  b.balls.push({ id: `${o.id}:messenger`, r, voice: o.voice, color: [0.8, 0.82, 0.9], segs: [{ kind: 'hold', t0: 0, t1: t0, x: o.messengerFrom.x, y: o.messengerFrom.y }, flightBetween(t0, o.messengerFrom, o.tipTime, landPt, o.g), after], fadeIn: 0.2, fadeOut: 0.5, hits: [] });
  b.props.push({
    id: `${o.id}:beam`,
    draw(dl: DrawList, t: number, c: PropCtx) {
      const a = tilt(t);
      const ex = Math.cos(a) * o.half;
      const ey = Math.sin(a) * o.half;
      dl.line(o.pivot.x - ex, o.pivot.y + ey, o.pivot.x + ex, o.pivot.y - ey, 0.08, c.pal.structure, 0.95, 0.06);
      dl.line(o.pivot.x, o.pivot.y, o.pivot.x - 0.3, o.pivot.y - 0.6, 0.05, c.pal.structure, 0.8);
      dl.line(o.pivot.x, o.pivot.y, o.pivot.x + 0.3, o.pivot.y - 0.6, 0.05, c.pal.structure, 0.8);
      dl.disc(o.pivot.x, o.pivot.y, 0.1, c.pal.text, 0.9);
      // cup at the right end
      const e = endAt(t);
      dl.arc(e.x, e.y + 0.18, 0.28, 0.03, Math.PI * 1.05, Math.PI * 0.9, c.pal.structure, 0.8);
    },
  });
  return { endAt, tilt };
}

// ------------------------------------------------------------------ route helpers

export function helixPath(cx: number, top: number, bottom: number, radius: number, turns: number, startAngle: number, n = 240): Path {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const a = startAngle + u * turns * TAU;
    pts.push({ x: cx + Math.cos(a) * radius, y: top + (bottom - top) * u + Math.sin(a) * radius * 0.32 });
  }
  return new Path(pts);
}

export function funnelPath(cx: number, cy: number, r0: number, r1: number, turns: number, squash: number, drop: number, n = 300): Path {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const a = Math.PI / 2 + u * turns * TAU;
    const r = r0 + (r1 - r0) * Math.pow(u, 0.85);
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * squash - u * drop });
  }
  // fall out of the funnel throat
  const last = pts[pts.length - 1];
  for (let i = 1; i <= 12; i++) pts.push({ x: last.x + (cx - last.x) * (i / 12), y: last.y - i * 0.12 });
  return new Path(pts);
}
