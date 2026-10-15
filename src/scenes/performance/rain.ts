// PERFORMANCE · Melody Rain: marbles are released from a dispenser rail and fall
// onto tuned platforms laid out like two keyboards (melody on the right,
// accompaniment and bass on the left). Each note is one marble whose release is
// timed so it lands exactly on its beat; chords are simultaneous drops. After
// striking, a marble rolls off the back of its platform and drops away behind
// the machine (recycled), so lanes never jam.
import { clamp } from '../../core/math.ts';
import { flightBetween, type Activation, type BallActor, type Segment } from '../../choreography/core.ts';
import { lastIndexAtOrBefore } from '../../core/math.ts';
import { noteName, type TimedNote, type VoiceRole } from '../../music/score.ts';
import type { DrawList } from '../../rendering/draw.ts';
import type { Choreography, Family, FamilyContext, Prop, PropCtx } from './perfScene.ts';

const HIGH: VoiceRole[] = ['melody', 'counter'];

interface Lane {
  id: string;
  group: 'high' | 'low';
  pitch: number;
  x: number;
  y: number;
  side: number;
  voice: VoiceRole;
  releases: number[];
  impacts: number[];
}

export const rainFamily: Family = {
  id: 'rain',
  title: 'Melody Rain',
  blurb: 'Marbles rain from a dispenser onto tuned platforms — melody on the right keyboard, accompaniment and bass on the left. Every note is one marble, released so it lands on the beat; chords fall together.',
  motion: 'Choreographed performance · timed releases on true ballistic arcs',
  defaultSong: 'fur-elise',
  defaultVoicing: 'classic',
  leadIn: 1.6,
  supports: () => null,
  build(notes: TimedNote[], ctx: FamilyContext): Choreography {
    const W = 8.6;
    const gap = 0.7;
    const yTop = 7.6;
    const padY = -2.6;
    const Tf = 1.05;
    const groups: Record<'high' | 'low', number[]> = { high: [], low: [] };
    for (const n of notes) {
      const g = HIGH.includes(n.voice) ? 'high' : 'low';
      if (!groups[g].includes(n.pitch)) groups[g].push(n.pitch);
    }
    // if a piece has no lower voices, spread the melody over the whole width
    const single = groups.low.length === 0;
    const lanes = new Map<string, Lane>();
    let minSpacing = Infinity;
    for (const g of ['high', 'low'] as const) {
      const ps = groups[g].sort((a, b) => a - b);
      if (!ps.length) continue;
      const x0 = single ? -W : g === 'high' ? gap : -W;
      const x1 = single ? W : g === 'high' ? W : -gap;
      const spacing = (x1 - x0) / ps.length;
      minSpacing = Math.min(minSpacing, spacing);
      ps.forEach((p, i) => {
        const x = x0 + spacing * (i + 0.5);
        // a gentle smile: outer lanes slightly higher
        const u = (i + 0.5) / ps.length - 0.5;
        const voiceCount = new Map<VoiceRole, number>();
        for (const n of notes) if (n.pitch === p && (HIGH.includes(n.voice) ? 'high' : 'low') === g) voiceCount.set(n.voice, (voiceCount.get(n.voice) ?? 0) + 1);
        const voice = [...voiceCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'melody';
        lanes.set(`${g}:${p}`, { id: `pad:${g}:${p}`, group: g, pitch: p, x, y: padY + u * u * 2.2, side: i % 2 === 0 ? -1 : 1, voice, releases: [], impacts: [] });
      });
    }
    const r = clamp(minSpacing * 0.32, 0.1, 0.24);
    const padHalf = clamp(minSpacing * 0.36, 0.12, 0.45);
    const padTh = 0.07;
    const balls: BallActor[] = [];
    const acts: Activation[] = [];
    notes.forEach((n, i) => {
      const g = HIGH.includes(n.voice) ? 'high' : 'low';
      const lane = lanes.get(`${g}:${n.pitch}`)!;
      const T = n.time;
      const hitY = lane.y + padTh + r;
      const g0 = (2 * (yTop - hitY)) / (Tf * Tf);
      const t0 = T - Tf;
      const start = { x: lane.x, y: yTop };
      const hit = { x: lane.x, y: hitY };
      const fall = flightBetween(t0, start, T, hit, g0);
      // bounce off the back of the pad: small hop toward the lane's side, then away behind the machine
      const vin = g0 * Tf;
      const out: Segment = { kind: 'flight', t0: T, t1: T + 0.6, x0: hit.x, y0: hit.y, vx: lane.side * 0.9, vy: vin * 0.28, g: g0 };
      const segs: Segment[] = [{ kind: 'hold', t0: t0 - 0.22, t1: t0, x: start.x, y: start.y }, fall, out];
      balls.push({
        id: `b${i}`,
        r,
        voice: n.voice,
        segs,
        fadeIn: 0.2,
        fadeOut: 0.3,
        depth: (t) => clamp((t - T) / 0.4, 0, 1),
        hits: [T],
      });
      lane.releases.push(t0);
      lane.impacts.push(T);
      acts.push({
        time: T,
        target: lane.id,
        notes: [{ pitch: n.pitch, vel: n.vel, dur: n.dur, inst: ctx.voicing[n.voice] }],
        x: lane.x,
        y: lane.y + padTh,
        nx: 0,
        ny: 1,
        voice: n.voice,
        ball: `b${i}`,
        label: noteName(n.pitch),
      });
    });
    const props: Prop[] = [];
    // dispenser rails
    const rails: { x0: number; x1: number; label: string }[] = single
      ? [{ x0: -W, x1: W, label: 'MELODY' }]
      : [
          { x0: -W, x1: -gap, label: 'ACCOMPANIMENT & BASS' },
          { x0: gap, x1: W, label: 'MELODY' },
        ];
    props.push({
      id: 'rails',
      draw(dl: DrawList, _t: number, c: PropCtx) {
        for (const rl of rails) {
          dl.rect((rl.x0 + rl.x1) / 2, yTop + 0.42, (rl.x1 - rl.x0) / 2 + 0.2, 0.32, 0, c.pal.structure, 0.22, 0.25, 0, 0);
          dl.line(rl.x0 - 0.2, yTop + 0.1, rl.x1 + 0.2, yTop + 0.1, 0.05, c.pal.structure, 0.8, 0.06);
          dl.line(rl.x0 - 0.2, yTop + 0.74, rl.x1 + 0.2, yTop + 0.74, 0.05, c.pal.structure, 0.8, 0.06);
          dl.text(rl.label, (rl.x0 + rl.x1) / 2, padY - 2.3, 0.3, c.pal.dim, 0.7, 'center');
        }
      },
    });
    for (const lane of lanes.values()) {
      const tilt = Math.atan2(lane.side * 0.9, 1 + 0.28) * 0.35;
      props.push({
        id: lane.id,
        draw(dl: DrawList, t: number, c: PropCtx) {
          const col = c.voiceColor(lane.voice);
          const f = c.flash(lane.id, t);
          // lane guide: brightens while a marble is falling toward this pad
          const k = lastIndexAtOrBefore(lane.releases, t);
          const falling = k >= 0 && t < lane.impacts[k];
          if (c.highlights || falling) {
            const a = falling ? 0.22 : 0.05;
            dl.line(lane.x, yTop - 0.1, lane.x, lane.y + 0.3, 0.012, col, a);
          }
          // dispenser gate flap opens briefly at each release
          const gr = k >= 0 ? t - lane.releases[k] : Infinity;
          const open = gr < 0.25 ? Math.sin((gr / 0.25) * Math.PI) : 0;
          dl.line(lane.x - r * 1.3, yTop - 0.02, lane.x - r * 1.3 + Math.cos(-open * 1.2) * r * 1.2, yTop - 0.02 + Math.sin(-open * 1.2) * r * 1.2, 0.025, c.pal.text, 0.6);
          dl.line(lane.x + r * 1.3, yTop - 0.02, lane.x + r * 1.3 - Math.cos(-open * 1.2) * r * 1.2, yTop - 0.02 + Math.sin(-open * 1.2) * r * 1.2, 0.025, c.pal.text, 0.6);
          // tuned platform (a short bar) with a support post
          const dy = -f * 0.06;
          dl.line(lane.x, lane.y - 0.15, lane.x, lane.y - 1.2, 0.02, c.pal.structure, 0.4);
          const cx = lane.x;
          const cy = lane.y + dy;
          dl.line(cx - Math.cos(tilt) * padHalf, cy - Math.sin(tilt) * padHalf, cx + Math.cos(tilt) * padHalf, cy + Math.sin(tilt) * padHalf, padTh + f * 0.03, col, 0.95, 0.1 + f * 0.35);
          if (f > 0.03) dl.glow(cx, cy, padHalf * 3, col, f * 0.55);
          if (c.labels) dl.text(noteName(lane.pitch), cx, lane.y - 0.42, clamp(padHalf * 0.85, 0.15, 0.28), c.pal.text, 0.45 + f * 0.5, 'center');
        },
      });
    }
    const last = notes.length ? notes[notes.length - 1].time : 0;
    return {
      balls,
      props,
      acts,
      duration: last + 3,
      bounds: { minX: -W - 0.5, minY: padY - 2.8, maxX: W + 0.5, maxY: yTop + 1.2 },
      maxSpeed: 40,
      contactTol: 0.02,
    };
  },
};
