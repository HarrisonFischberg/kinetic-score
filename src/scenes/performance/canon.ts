// PERFORMANCE · Canon Contraption: the flagship vertical Rube Goldberg machine.
// The excerpt is split into four stages stacked top to bottom (one per section
// of the piece); within each stage every voice is played by a different kind of
// mechanism, and a finale bowl catches the closing chord. Mechanisms used:
// hopper release gates, chime stairs, a rotary bell hammer with bell tower, a
// paddle wheel, a tuned pegboard, a seesaw launcher, a guided spiral, drip
// hoppers, pendulum hammers, a funnel, a branching accompaniment lane, a pin
// wheel and the final bowl. The camera follows stage by stage.
import { TAU, clamp } from '../../core/math.ts';
import { Path, flightBetween, type Pt, type Segment } from '../../choreography/core.ts';
import { bounceChain, dripHopper, funnelPath, groupNotes, helixPath, newBuilder, pathRide, pendulumRow, pinWheel, rotaryHammer, seesaw, type MachineBuilder, type NoteGroup } from '../../choreography/mechanisms.ts';
import { beatToSeconds, noteName, type TimedNote, type VoiceRole } from '../../music/score.ts';
import type { DrawList } from '../../rendering/draw.ts';
import type { Choreography, Family, FamilyContext, Prop, PropCtx } from './perfScene.ts';

const STAGE_GAP = 21;
const HALF_H = 9.6;
const HALF_W = 13.2;
const BALL_R = 0.22;
const G = 0; // automatic per mechanism (see bounceChain)
const G_FIXED = 12;

const STAGE_TITLES = ['I · Hopper & Bell Tower', 'II · Paddle Wheel, Pegboard & Spiral', 'III · Pendulums, Funnel & Branching Lane', 'IV · Cascade Stairs & Pin Wheel'];

function stagesFor(notes: TimedNote[], ctx: FamilyContext): { bounds: number[]; finaleTime: number | null } {
  const sc = ctx.score;
  const beatsPerBar = (sc.meter.numerator * 4) / sc.meter.denominator;
  const groups = groupNotes(notes);
  const last = groups[groups.length - 1];
  const finale = last && last.notes.length >= 2 ? last : null;
  // stage boundaries at bar lines, splitting the music before the finale into four
  const lastBeat = finale ? sc.notes.filter((n) => Math.abs(ctx.leadIn + beatToSeconds(n.t, sc, ctx.tempo) - finale.time) < 0.02)[0]?.t ?? sc.durationBeats : sc.durationBeats;
  const stageBeats = Math.max(beatsPerBar, Math.round(lastBeat / 4 / beatsPerBar) * beatsPerBar);
  const sec = (b: number) => ctx.leadIn + beatToSeconds(b, sc, ctx.tempo) - 1e-6;
  const bounds = [-Infinity, sec(stageBeats + sc.pickupBeats), sec(stageBeats * 2 + sc.pickupBeats), sec(stageBeats * 3 + sc.pickupBeats), finale ? finale.time - 1e-6 : Infinity];
  return { bounds, finaleTime: finale ? finale.time : null };
}

/** chime-stair layout across a region */
function stairs(x0: number, x1: number, yTop: number, yBot: number) {
  return (k: number, g: NoteGroup, n: number): Pt => {
    const u = (k + 0.5) / n;
    return { x: x0 + (x1 - x0) * u, y: yTop + (yBot - yTop) * u + clamp((g.top - 70) * 0.06, -0.8, 0.8) };
  };
}

/** Galton-board layout: one row per note, column by pitch, snapped to a staggered lattice */
function pegboard(x0: number, x1: number, yTop: number, yBot: number, lo: number, hi: number) {
  const col = 0.62;
  return (k: number, g: NoteGroup, n: number): Pt => {
    const y = yTop + (yBot - yTop) * ((k + 0.5) / n);
    const u = hi > lo ? (g.top - lo) / (hi - lo) : 0.5;
    const raw = x0 + 0.4 + (x1 - x0 - 0.8) * u;
    const off = k % 2 ? col / 2 : 0;
    return { x: Math.round((raw - off) / col) * col + off, y };
  };
}

function wire(id: string, a: Pt, b: Pt, t0: number, t1: number): Prop {
  return {
    id,
    layer: 'back',
    draw(dl: DrawList, t: number, c: PropCtx) {
      // the relay link is only shown while it carries its signal
      const vis = clamp(Math.min(t - (t0 - 0.6), t1 + 0.9 - t) / 0.4, 0, 1);
      if (vis <= 0) return;
      dl.line(a.x, a.y, b.x, b.y, 0.02, c.pal.accent, 0.35 * vis);
      if (t >= t0 - 0.05 && t <= t1 + 0.3) {
        const u = clamp((t - t0) / Math.max(0.05, t1 - t0), 0, 1);
        const x = a.x + (b.x - a.x) * u;
        const y = a.y + (b.y - a.y) * u;
        dl.glow(x, y, 0.7, c.pal.accent, 0.8 * (1 - Math.max(0, t - t1) / 0.3));
        dl.disc(x, y, 0.08, c.pal.accent, 0.9);
      }
    },
  };
}

function stageFrame(k: number, cy: number): Prop {
  return {
    id: `stage${k}`,
    layer: 'back',
    draw(dl: DrawList, _t: number, c: PropCtx) {
      dl.rect(0, cy, HALF_W + 0.3, HALF_H + 0.3, 0, c.pal.grid, 0.5, 0.6, 0.03);
      dl.text(STAGE_TITLES[k], -HALF_W + 0.4, cy + HALF_H - 0.45, 0.42, c.pal.dim, 0.75, 'left');
    },
  };
}

/** branching accompaniment lane: switchback ramps with forks; the marble takes one branch at each fork */
function branchingLane(b: MachineBuilder, notes: TimedNote[], id: string, voice: VoiceRole, x0: number, x1: number, yTop: number, yBot: number): void {
  if (!notes.length) return;
  const levels = 5;
  const route: Pt[] = [];
  const alt: [Pt, Pt][] = [];
  const dy = (yTop - yBot) / levels;
  route.push({ x: x0 + 0.3, y: yTop + 0.8 });
  for (let i = 0; i < levels; i++) {
    const yA = yTop - i * dy;
    const yB = yA - dy * 0.75;
    const ltr = i % 2 === 0;
    const xa = ltr ? x0 + 0.3 : x1 - 0.3;
    const xb = ltr ? x1 - 0.3 : x0 + 0.3;
    const mid = (xa + xb) / 2;
    // fork: upper and lower branches between the quarter points; the marble alternates
    const qa = xa + (xb - xa) * 0.25;
    const qb = xa + (xb - xa) * 0.75;
    const yq = yA - (yA - yB) * 0.25;
    const yq2 = yA - (yA - yB) * 0.75;
    const takeUpper = i % 2 === 0;
    route.push({ x: xa, y: yA }, { x: qa, y: yq });
    const up = { x: mid, y: (yq + yq2) / 2 + 0.45 };
    const dn = { x: mid, y: (yq + yq2) / 2 - 0.45 };
    route.push(takeUpper ? up : dn, { x: qb, y: yq2 }, { x: xb, y: yB });
    alt.push([{ x: qa, y: yq }, takeUpper ? dn : up], [takeUpper ? dn : up, { x: qb, y: yq2 }]);
  }
  route.push({ x: route[route.length - 1].x, y: yBot - 0.6 });
  // densify for smooth motion
  const dense: Pt[] = [];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const c = route[i];
    const n = Math.max(2, Math.ceil(Math.hypot(c.x - a.x, c.y - a.y) / 0.15));
    for (let k = 0; k < n; k++) dense.push({ x: a.x + ((c.x - a.x) * k) / n, y: a.y + ((c.y - a.y) * k) / n });
  }
  dense.push(route[route.length - 1]);
  const path = new Path(dense);
  pathRide(b, notes, { id, voice, r: BALL_R * 0.85, path, gateFrom: 1.2, gateTo: path.length - 0.9, style: 'gate', trackWidth: 0.05, drawTrack: true });
  b.props.push({
    id: `${id}:branches`,
    layer: 'back',
    draw(dl: DrawList, _t: number, c: PropCtx) {
      for (const [a, z] of alt) dl.line(a.x, a.y, z.x, z.y, 0.04, c.pal.structure, 0.35);
      for (const [a] of alt) dl.disc(a.x, a.y, 0.09, c.pal.dim, 0.8);
    },
  });
}

export const canonFamily: Family = {
  id: 'canon',
  title: 'Canon Contraption',
  blurb: 'A four-stage vertical Rube Goldberg machine. Hoppers release marbles down chime stairs and pegboards, a seesaw flings one into a spiral, pendulums and a rotary hammer ring bells, wheels pluck combs, and a final bowl catches the closing chord.',
  motion: 'Choreographed performance · hybrid physics: real ballistic arcs and rails solved backwards from the score',
  defaultSong: 'canon-in-d',
  defaultVoicing: 'classic',
  leadIn: 2.6,
  defaultCamera: 'follow',
  supports: () => null,
  build(notes: TimedNote[], ctx: FamilyContext): Choreography {
    const b = newBuilder(ctx.voicing);
    const { bounds: sb, finaleTime } = stagesFor(notes, ctx);
    const inStage = (k: number, v: VoiceRole) => notes.filter((n) => n.voice === v && n.time >= sb[k] && n.time < sb[k + 1]);
    const props: Prop[] = [];
    const cyOf = (k: number) => -k * STAGE_GAP;
    const pitchRange = (ns: TimedNote[]) => (ns.length ? [Math.min(...ns.map((n) => n.pitch)), Math.max(...ns.map((n) => n.pitch))] : [60, 72]);
    const stageStart = [0, 0, 0, 0];
    const melodyEnds: { pt: Pt; t: number }[] = [];

    for (let k = 0; k < 4; k++) props.push(stageFrame(k, cyOf(k)));

    // ---------------- Stage I
    {
      const cy = cyOf(0);
      rotaryHammer(b, inStage(0, 'bass'), { id: 's1:bass', voice: 'bass', pivot: { x: -8, y: cy - 0.6 }, radius: 4.4, from: Math.PI * 0.12, to: Math.PI * 0.88, bellR: 0.5 });
      const mel = inStage(0, 'melody');
      if (mel.length) {
        const r = bounceChain(b, mel, { id: 's1:mel', voice: 'melody', r: BALL_R, g: G, start: { x: -0.6, y: cy + 8.2 }, layout: stairs(0.4, 12, cy + 6, cy - 5.5), style: 'stair', padHalf: 0.55, exit: { x: 12.4, y: cy - 8.6 }, exitDur: 0.7, dropTime: 0.85, maxHop: 1.3 });
        stageStart[0] = r.releaseTime;
        const g = groupNotes(mel);
        melodyEnds.push({ pt: stairs(0.4, 12, cy + 6, cy - 5.5)(g.length - 1, g[g.length - 1], g.length), t: g[g.length - 1].time });
      }
      dripHopper(b, inStage(0, 'counter'), { id: 's1:ctr', voice: 'counter', x0: -12.6, x1: -4.2, topY: cy - 3.4, padY: cy - 8.4, fall: 0.8 });
      const acc = inStage(0, 'accomp');
      if (acc.length) pinWheel(b, acc, { id: 's1:acc', voice: 'accomp', center: { x: 4.2, y: cy - 6 }, radius: 2.3, combAngle: Math.PI, from: 0 });
    }

    // ---------------- Stage II
    {
      const cy = cyOf(1);
      const bass = inStage(1, 'bass');
      if (bass.length) pinWheel(b, bass, { id: 's2:bass', voice: 'bass', center: { x: -9, y: cy + 3.2 }, radius: 2.9, combAngle: 0, from: 0 });
      const mel = inStage(1, 'melody');
      if (mel.length) {
        const [lo, hi] = pitchRange(mel);
        const lay = pegboard(-4, 4, cy + 6.6, cy - 7.4, lo, hi);
        const r = bounceChain(b, mel, { id: 's2:mel', voice: 'melody', r: BALL_R, g: G, start: { x: 0, y: cy + 8.6 }, layout: lay, style: 'peg', padHalf: 0.2, exit: { x: 4.6, y: cy - 9 }, exitDur: 0.6, dropTime: 0.8, maxHop: 1.3 });
        stageStart[1] = r.releaseTime;
        const g = groupNotes(mel);
        if (melodyEnds.length) props.push(wire('relay12', melodyEnds[0].pt, { x: 0, y: cy + 8.6 }, melodyEnds[0].t, r.releaseTime));
        melodyEnds.push({ pt: lay(g.length - 1, g[g.length - 1], g.length), t: g[g.length - 1].time });
        // decorative lattice
        props.push({
          id: 's2:lattice',
          layer: 'back',
          draw(dl: DrawList, _t: number, c: PropCtx) {
            for (let row = 0; row < 18; row++) {
              const y = cy + 6.6 - row * 0.8;
              const off = row % 2 ? 0.31 : 0;
              for (let x = -3.72 + off; x <= 3.8; x += 0.62) dl.disc(x, y, 0.035, c.pal.grid, 0.9);
            }
          },
        });
      }
      const ctr = inStage(1, 'counter');
      if (ctr.length) {
        const helix = helixPath(8.8, cy + 4.6, cy - 7.6, 2.5, 3.2, Math.PI * 0.95);
        // a messenger marble tips the seesaw, which flings the counter-melody marble onto the spiral
        const pre = (tr: number, start: Pt): Segment[] => {
          const tipTime = tr - 1.35;
          const ss = seesaw(b, { id: 's2:seesaw', pivot: { x: 5.4, y: cy + 7.2 }, half: 1.5, tipTime, messengerFrom: { x: 2.6, y: cy + 9.2 }, messengerDrop: 0.6, g: G_FIXED, voice: 'counter' });
          const launchT = tipTime + 0.22;
          const e = ss.endAt(launchT);
          return [
            {
              kind: 'fn',
              t0: 0,
              t1: launchT,
              f: (t, out) => {
                const q = ss.endAt(t);
                out.x = q.x;
                out.y = q.y + 0.28;
                return out;
              },
            },
            flightBetween(launchT, { x: e.x, y: e.y + 0.28 }, launchT + 0.75, start, G_FIXED),
          ];
        };
        pathRide(b, ctr, { id: 's2:ctr', voice: 'counter', r: BALL_R * 0.9, path: helix, gateFrom: 1.0, gateTo: helix.length - 1.2, style: 'chime', trackWidth: 0.06, drawTrack: true, pre });
      }
      dripHopper(b, inStage(1, 'accomp'), { id: 's2:acc', voice: 'accomp', x0: -12.6, x1: -5.4, topY: cy - 3.2, padY: cy - 8.5, fall: 0.75 });
    }

    // ---------------- Stage III
    {
      const cy = cyOf(2);
      pendulumRow(b, inStage(2, 'bass'), { id: 's3:bass', voice: 'bass', x0: -4.5, x1: 4.5, pivotY: cy + 8.6, length: 2.3 });
      const mel = inStage(2, 'melody');
      if (mel.length) {
        const fp = funnelPath(0, cy - 0.4, 5.1, 0.55, 3.1, 0.42, 2.4);
        // feed rail from the upper left into the funnel rim
        const start = fp.at(0);
        const feed: Pt[] = [];
        for (let i = 0; i <= 20; i++) feed.push({ x: -7.5 + (start.x + 7.5) * (i / 20), y: cy + 4.8 + (start.y - cy - 4.8) * (i / 20) });
        const pts: Pt[] = [...feed];
        for (let i = 1; i < fp.xs.length; i++) pts.push({ x: fp.xs[i], y: fp.ys[i] });
        const path = new Path(pts);
        const feedLen = Math.hypot(start.x + 7.5, start.y - cy - 4.8);
        const r = pathRide(b, mel, { id: 's3:mel', voice: 'melody', r: BALL_R, path, gateFrom: feedLen + 0.6, gateTo: path.length - 1.8, style: 'chime', trackWidth: 0.05, drawTrack: false });
        if (melodyEnds.length) props.push(wire('relay23', melodyEnds[melodyEnds.length - 1].pt, { x: -7.5, y: cy + 4.8 }, melodyEnds[melodyEnds.length - 1].t, r.start));
        stageStart[2] = r.start;
        props.push({
          id: 's3:funnel',
          layer: 'back',
          draw(dl: DrawList, _t: number, c: PropCtx) {
            // funnel bowl: concentric ellipses narrowing to the throat
            for (let i = 0; i <= 7; i++) {
              const u = i / 7;
              const rr = 5.3 - u * 4.6;
              const yy = cy - 0.4 - u * 2.4;
              let px = 0;
              let py = 0;
              for (let k = 0; k <= 48; k++) {
                const a = (k / 48) * TAU;
                const x = Math.cos(a) * rr;
                const y = yy + Math.sin(a) * rr * 0.42;
                if (k) dl.line(px, py, x, y, 0.02, c.pal.structure, 0.25 + (1 - u) * 0.25);
                px = x;
                py = y;
              }
            }
            dl.line(-7.5, cy + 4.8, start.x, start.y, 0.06, c.pal.structure, 0.8, 0.05);
          },
        });
      }
      branchingLane(b, inStage(2, 'counter'), 's3:ctr', 'counter', 6.2, 12.8, cy + 4.6, cy - 8.4);
      dripHopper(b, inStage(2, 'accomp'), { id: 's3:acc', voice: 'accomp', x0: -12.8, x1: -6.4, topY: cy + 4.2, padY: cy - 3.2, fall: 0.8 });
    }

    // ---------------- Stage IV
    {
      const cy = cyOf(3);
      const mel = inStage(3, 'melody');
      if (mel.length) {
        const lay = stairs(-1.4, 12.2, cy + 7.6, cy - 6.6);
        const r = bounceChain(b, mel, { id: 's4:mel', voice: 'melody', r: BALL_R * 0.85, g: G, start: { x: -2.6, y: cy + 9 }, layout: lay, style: 'stair', padHalf: 0.32, exit: { x: 12.6, y: cy - 9 }, exitDur: 0.6, dropTime: 0.75, maxHop: 1.3 });
        if (melodyEnds.length) props.push(wire('relay34', melodyEnds[melodyEnds.length - 1].pt, { x: -2.6, y: cy + 9 }, melodyEnds[melodyEnds.length - 1].t, r.releaseTime));
        stageStart[3] = r.releaseTime;
      }
      const ctr = inStage(3, 'counter');
      if (ctr.length) pinWheel(b, ctr, { id: 's4:ctr', voice: 'counter', center: { x: -8.6, y: cy + 5.2 }, radius: 2.7, combAngle: 0, from: 0 });
      const acc = inStage(3, 'accomp');
      if (acc.length) {
        const [lo, hi] = pitchRange(acc);
        bounceChain(b, acc, { id: 's4:acc', voice: 'accomp', r: BALL_R * 0.85, g: G, start: { x: -9, y: cy + 0.9 }, layout: pegboard(-12.6, -5.4, cy - 0.2, cy - 8.2, lo, hi), style: 'peg', padHalf: 0.2, exit: { x: -5, y: cy - 9.2 }, exitDur: 0.5, dropTime: 0.6, maxHop: 1.3 });
      }
      rotaryHammer(b, inStage(3, 'bass'), { id: 's4:bass', voice: 'bass', pivot: { x: 3.4, y: cy - 8 }, radius: 3.6, from: Math.PI * 0.15, to: Math.PI * 0.85, bellR: 0.45 });
    }

    // ---------------- Finale bowl
    const bowlY = cyOf(3) - 15.5;
    const finale = finaleTime !== null ? notes.filter((n) => Math.abs(n.time - finaleTime) < 0.02) : [];
    if (finale.length) {
      const n = finale.length;
      const fall = 1.0;
      finale.forEach((note, i) => {
        const x = (i - (n - 1) / 2) * 1.5;
        const top = { x, y: bowlY + 7.2 };
        const chimeY = bowlY - 2.2 - Math.abs(i - (n - 1) / 2) * -0.4;
        const hit = { x, y: chimeY + 0.08 + BALL_R };
        const t0 = note.time - fall;
        const id = `fin:b${i}`;
        const rest = { x: x * 0.45, y: bowlY - 3.1 };
        const g0 = (2 * (top.y - hit.y)) / (fall * fall);
        b.balls.push({ id, r: BALL_R, voice: note.voice, segs: [{ kind: 'hold', t0: 0, t1: t0, ...top }, flightBetween(t0, top, note.time, hit, g0), flightBetween(note.time, hit, note.time + 0.5, rest, g0), { kind: 'hold', t0: note.time + 0.5, t1: note.time + 6, ...rest }], fadeIn: 0.3, fadeOut: 0.6, hits: [note.time] });
        const target = `fin:chime${i}`;
        b.acts.push({ time: note.time, target, notes: [{ pitch: note.pitch, vel: Math.min(1, note.vel + 0.1), dur: Math.max(note.dur, 2.5), inst: ctx.voicing[note.voice] }], x, y: chimeY + 0.08, nx: 0, ny: 1, voice: note.voice, ball: id, label: noteName(note.pitch) });
        b.props.push({
          id: target,
          draw(dl: DrawList, t: number, c: PropCtx) {
            const col = c.voiceColor(note.voice);
            const f = c.flash(target, t, 0.6);
            dl.line(x - 0.5, chimeY, x + 0.5, chimeY, 0.08, col, 0.95, 0.1 + f * 0.4);
            if (f > 0.03) dl.glow(x, chimeY, 2.2, col, f * 0.6);
            if (c.labels) dl.text(noteName(note.pitch), x, chimeY - 0.4, 0.24, c.pal.text, 0.5 + f * 0.5, 'center');
            // rack holding the finale marbles
            dl.line(x - 0.35, top.y - BALL_R - 0.05, x + 0.35, top.y - BALL_R - 0.05, 0.04, c.pal.structure, 0.8);
          },
        });
      });
    }
    props.push({
      id: 'bowl',
      layer: 'back',
      draw(dl: DrawList, t: number, c: PropCtx) {
        const glow = finaleTime !== null ? clamp(1 - Math.abs(t - finaleTime - 0.6) / 2, 0, 1) : 0;
        dl.arc(0, bowlY, 4.8, 0.12, Math.PI * 1.05, Math.PI * 0.9, c.pal.track, 0.9, 0.15 + glow * 0.5);
        dl.text('Finale', 0, bowlY - 5.6, 0.42, c.pal.dim, 0.8, 'center');
        // drain pipes from every stage feed the bowl
        for (const side of [-1, 1]) {
          dl.line(side * (HALF_W + 0.9), cyOf(0) - 8.6, side * (HALF_W + 0.9), bowlY + 1.5, 0.12, c.pal.structure, 0.35);
          dl.line(side * (HALF_W + 0.9), bowlY + 1.5, side * 4.6, bowlY + 0.4, 0.12, c.pal.structure, 0.35);
        }
      },
    });

    const lastNote = notes.length ? notes[notes.length - 1].time : 0;
    // follow the music stage by stage, moving on a little before each new section starts
    const focusStages = sb.slice(0, 4).map((s, k) => ({ start: k === 0 ? -Infinity : s - 1.3, cy: cyOf(k) }));
    void stageStart;
    return {
      balls: b.balls,
      props: [...props, ...b.props],
      acts: b.acts,
      duration: lastNote + 4,
      bounds: { minX: -HALF_W - 1.4, minY: bowlY - 6.4, maxX: HALF_W + 1.4, maxY: HALF_H + 0.8 },
      maxSpeed: 40,
      contactTol: 0.03,
      problems: b.problems,
      focus(t: number) {
        let k = 0;
        for (let i = 0; i < 4; i++) if (t >= focusStages[i].start) k = i;
        if (finaleTime !== null && t >= finaleTime - 2.4) return { x: 0, y: bowlY + 2.2, h: 19 };
        return { x: 0, y: focusStages[k].cy, h: HALF_H * 2 + 1.4 };
      },
    };
  },
};
