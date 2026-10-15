// PERFORMANCE · Orbital Classics: a circular arena in zero gravity, split by an
// equator deflector. Tuned chimes line the rim — the melody's pitches on the
// upper arc, the bass and accompaniment on the lower arc — and two marbles
// travel in straight guided lines from chime to chime. Because every chord of
// the upper arc stays above the equator, the two marbles never cross; repeated
// notes are reached by glancing off the equator deflector. Arpeggios draw
// star polygons that change with every harmony.
import { clamp } from '../../core/math.ts';
import { Path, type Pt, type Segment } from '../../choreography/core.ts';
import { groupNotes, newBuilder, type NoteGroup } from '../../choreography/mechanisms.ts';
import { noteName, timeNotes, type ScoreData, type TimedNote, type VoiceRole } from '../../music/score.ts';
import type { DrawList } from '../../rendering/draw.ts';
import type { Choreography, Family, FamilyContext, Prop, PropCtx } from './perfScene.ts';
import { OrbitalSandbox } from './orbitalSandbox.ts';

export const R = 7.5;
const BALL = 0.22;
const CH_TH = 0.1;
const MAX_SPEED = 56;

export interface Half {
  key: 'up' | 'bass' | 'mid';
  /** +1 above the equator, −1 below */
  sign: 1 | -1;
  voices: VoiceRole[];
  /** arc of the rim used by this sector, low pitch → high pitch */
  a0: number;
  a1: number;
}

// three sectors on disjoint arcs: chords of disjoint arcs never cross, so the marbles never meet
export const HALVES: Half[] = [
  { key: 'up', sign: 1, voices: ['melody'], a0: Math.PI * 0.94, a1: Math.PI * 0.06 },
  { key: 'bass', sign: -1, voices: ['bass'], a0: Math.PI * 1.06, a1: Math.PI * 1.47 },
  { key: 'mid', sign: -1, voices: ['counter', 'accomp'], a0: Math.PI * 1.53, a1: Math.PI * 1.94 },
];

export function chimeAngles(pitches: number[], h: Half): Map<number, number> {
  const m = new Map<number, number>();
  pitches.forEach((p, i) => m.set(p, pitches.length === 1 ? (h.a0 + h.a1) / 2 : h.a0 + ((h.a1 - h.a0) * i) / (pitches.length - 1)));
  return m;
}

/** where a marble glances off when it must strike the same chime twice in a row */
function detour(h: Half, a: Pt): Pt {
  if (h.key === 'up') return { x: a.x * 0.55, y: 0.12 + BALL };
  // lower sectors: dip toward the middle of the sector's chord
  const mid = (h.a0 + h.a1) / 2;
  const cx = Math.cos(mid) * R * 0.62;
  const cy = Math.sin(mid) * R * 0.62;
  return { x: (a.x + cx) / 2, y: (a.y + cy) / 2 };
}

const contact = (a: number): Pt => ({ x: Math.cos(a) * (R - CH_TH - BALL), y: Math.sin(a) * (R - CH_TH - BALL) });

/** fastest straight-line speed the arena would need for these notes */
export function orbitalRequiredSpeed(notes: TimedNote[]): number {
  let worst = 0;
  for (const h of HALVES) {
    const groups = groupNotes(notes.filter((n) => h.voices.includes(n.voice)));
    const angles = chimeAngles([...new Set(groups.map((g) => g.top))].sort((a, b) => a - b), h);
    for (let k = 1; k < groups.length; k++) {
      const a = contact(angles.get(groups[k - 1].top)!);
      const b = contact(angles.get(groups[k].top)!);
      const d = groups[k].top === groups[k - 1].top ? 2 * Math.hypot(a.x - detour(h, a).x, a.y - detour(h, a).y) : Math.hypot(a.x - b.x, a.y - b.y);
      worst = Math.max(worst, d / Math.max(1e-3, groups[k].time - groups[k - 1].time));
    }
  }
  return worst;
}

const supportCache = new Map<string, string | null>();

export const orbitalFamily: Family = {
  sandbox: {
    label: 'Sandbox — free physics, marbles grow on impact',
    motion: 'Sandbox · interpretive: real contacts with the song’s chimes, marbles grow on impact',
    make: (score, voicing, svc, seed) => new OrbitalSandbox(score, voicing, svc, seed),
  },
  id: 'orbital',
  title: 'Orbital Classics',
  blurb: 'Zero-gravity string art: marbles glide in straight lines between tuned chimes around a circular arena — melody above the equator, bass below — tracing a new star with every chord. (For impacts that grow the marble, try the Growing Ball playground.)',
  motion: 'Choreographed performance · guided straight runs between chimes, equator deflector for repeats',
  defaultSong: 'prelude-c-major',
  defaultVoicing: 'glass',
  leadIn: 1.6,
  supports(score: ScoreData): string | null {
    const hit = supportCache.get(score.id);
    if (hit !== undefined) return hit;
    // check at the slowest tempo the scene offers? No: at default tempo; faster tempos are checked again on build
    const need = orbitalRequiredSpeed(timeNotes(score, 1, 0));
    const res = need > MAX_SPEED ? `leaps too fast for the arena (needs ${need.toFixed(0)} units/s, limit ${MAX_SPEED})` : null;
    supportCache.set(score.id, res);
    return res;
  },
  build(notes: TimedNote[], ctx: FamilyContext): Choreography {
    const b = newBuilder(ctx.voicing);
    const props: Prop[] = [];
    for (const h of HALVES) {
      const ns = notes.filter((n) => h.voices.includes(n.voice));
      const groups = groupNotes(ns);
      if (!groups.length) continue;
      const pitches = [...new Set(groups.map((g) => g.top))].sort((a, b) => a - b);
      const angles = chimeAngles(pitches, h);
      const voice: VoiceRole = h.key === 'up' ? 'melody' : h.key === 'bass' ? 'bass' : groups[0].notes[0].voice;
      const ballId = `orb:${h.key}`;
      const midA = (h.a0 + h.a1) / 2;
      const home: Pt = h.key === 'up' ? { x: 0, y: R * 0.42 } : { x: Math.cos(midA) * R * 0.55, y: Math.sin(midA) * R * 0.55 };
      const segs: Segment[] = [];
      const lin = (t0: number, t1: number, a: Pt, z: Pt): Segment => ({ kind: 'path', t0, t1, path: new Path([a, z]), s0: 0, s1: Math.hypot(z.x - a.x, z.y - a.y), ease: 'linear' });
      const first = contact(angles.get(groups[0].top)!);
      const launch = Math.max(0.3, Math.hypot(first.x - home.x, first.y - home.y) / 9);
      segs.push({ kind: 'hold', t0: 0, t1: groups[0].time - launch, ...home });
      segs.push({ kind: 'path', t0: groups[0].time - launch, t1: groups[0].time, path: new Path([home, first]), s0: 0, s1: Math.hypot(first.x - home.x, first.y - home.y), ease: 'in' });
      const deflections: { t: number; p: Pt }[] = [];
      for (let k = 1; k < groups.length; k++) {
        const a = contact(angles.get(groups[k - 1].top)!);
        const z = contact(angles.get(groups[k].top)!);
        const t0 = groups[k - 1].time;
        const t1 = groups[k].time;
        if (groups[k].top === groups[k - 1].top) {
          // same chime twice: glance off the equator deflector and come back
          const mid = detour(h, a);
          const tm = (t0 + t1) / 2;
          segs.push(lin(t0, tm, a, mid), lin(tm, t1, mid, z));
          deflections.push({ t: tm, p: mid });
          b.mech.push({ time: tm, kind: 'tick', vel: 0.5, x: mid.x });
        } else segs.push(lin(t0, t1, a, z));
      }
      const tl = groups[groups.length - 1].time;
      const lastP = contact(angles.get(groups[groups.length - 1].top)!);
      segs.push({ kind: 'path', t0: tl, t1: tl + 1.2, path: new Path([lastP, home]), s0: 0, s1: Math.hypot(home.x - lastP.x, home.y - lastP.y), ease: 'out' });
      segs.push({ kind: 'hold', t0: tl + 1.2, t1: tl + 4, ...home });
      b.balls.push({ id: ballId, r: BALL, voice, segs, fadeIn: 0.4, fadeOut: 0.8, hits: groups.map((g) => g.time) });
      const chimeOf = (p: number) => `orb:${h.key}:chime${p}`;
      groups.forEach((g: NoteGroup) => {
        const a = angles.get(g.top)!;
        const cp = contact(a);
        b.acts.push({
          time: g.time,
          target: chimeOf(g.top),
          notes: g.notes.map((n) => ({ pitch: n.pitch, vel: n.vel, dur: n.dur, inst: ctx.voicing[n.voice] })),
          x: cp.x + Math.cos(a) * BALL,
          y: cp.y + Math.sin(a) * BALL,
          nx: -Math.cos(a),
          ny: -Math.sin(a),
          voice,
          ball: ballId,
          label: g.notes.map((n) => noteName(n.pitch)).join('·'),
        });
      });
      const half = clamp((Math.abs(h.a1 - h.a0) / Math.max(1, pitches.length)) * 0.42, 0.03, 0.16);
      for (const p of pitches) {
        const a = angles.get(p)!;
        const target = chimeOf(p);
        props.push({
          id: target,
          draw(dl: DrawList, t: number, c: PropCtx) {
            const col = c.voiceColor(voice);
            const f = c.flash(target, t, 0.25);
            const next = c.next(target, t);
            const soon = next - t < 0.8 ? 1 - (next - t) / 0.8 : 0;
            dl.arc(0, 0, R - CH_TH / 2, CH_TH / 2 + f * 0.03, a - half, half * 2, col, 0.55 + f * 0.45 + soon * 0.2, 0.08 + f * 0.35);
            if (f > 0.03) dl.glow(Math.cos(a) * R, Math.sin(a) * R, 1.1, col, f * 0.6);
            if (c.labels) dl.text(noteName(p), Math.cos(a) * (R + 0.45), Math.sin(a) * (R + 0.45), 0.2, c.pal.text, 0.4 + f * 0.6, 'center');
          },
        });
      }
      if (deflections.length) {
        const dts = deflections.map((d) => d.t);
        props.push({
          id: `orb:${h.key}:deflect`,
          draw(dl: DrawList, t: number, c: PropCtx) {
            let f = 0;
            for (const dt of dts) if (t >= dt && t - dt < 0.3) f = Math.max(f, 1 - (t - dt) / 0.3);
            if (f > 0 && h.key === 'up') dl.line(-R * 0.86, 0.06, R * 0.86, 0.06, 0.03, c.pal.accent, f * 0.6, 0.15);
            else if (f > 0) dl.glow(home.x, home.y, 1.2, c.pal.accent, f * 0.5);
          },
        });
      }
    }
    props.unshift({
      id: 'orb:arena',
      layer: 'back',
      draw(dl: DrawList, t: number, c: PropCtx) {
        dl.ring(0, 0, R + 0.05, 0.02, c.pal.structure, 0.6);
        dl.ring(0, 0, R + 0.9, 0.015, c.pal.grid, 0.8);
        // slow decorative orbits
        for (let k = 0; k < 3; k++) {
          const a = t * (0.08 + k * 0.05) + k * 2.1;
          dl.disc(Math.cos(a) * (R + 0.9), Math.sin(a) * (R + 0.9), 0.07, c.pal.dim, 0.7);
        }
        dl.line(-R * 0.86, 0, R * 0.86, 0, 0.06, c.pal.structure, 0.85, 0.05);
        // divider between the two lower sectors
        dl.line(0, -0.4, 0, -R * 0.7, 0.025, c.pal.grid, 0.8);
        dl.disc(-R * 0.86, 0, 0.1, c.pal.text, 0.7);
        dl.disc(R * 0.86, 0, 0.1, c.pal.text, 0.7);
      },
    });
    const last = notes.length ? notes[notes.length - 1].time : 0;
    return {
      balls: b.balls,
      props: [...props, ...b.props],
      acts: b.acts,
      duration: last + 3,
      bounds: { minX: -R - 1.4, minY: -R - 1.4, maxX: R + 1.4, maxY: R + 1.4 },
      maxSpeed: MAX_SPEED * 1.05,
      contactTol: 0.02,
      problems: b.problems,
      mech: b.mech,
    };
  },
};
