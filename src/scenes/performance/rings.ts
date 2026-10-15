// PERFORMANCE · Ring Escape: concentric rings rotate around a glowing core.
// Each melodic phrase is one marble fired from the core straight outward; every
// note is the marble slipping through a ring's gap at that note's time. Ring
// rotation is solved so each real gap (the same gap used for the clearance
// check) lines up with every marble that must pass, using smooth, monotone,
// velocity-continuous motion. Rotation speed and glow rise with the music
// (the excerpt accelerates) but stay within safe limits. Bass notes ring on a
// row of pendulum hammers beneath.
import { TAU, clamp } from '../../core/math.ts';
import { lastIndexAtOrBefore } from '../../core/math.ts';
import { Path, type Segment } from '../../choreography/core.ts';
import { groupNotes, newBuilder, pendulumRow, type NoteGroup } from '../../choreography/mechanisms.ts';
import { noteName, timeNotes, type ScoreData, type TimedNote, type VoiceRole } from '../../music/score.ts';
import type { DrawList } from '../../rendering/draw.ts';
import type { Choreography, Family, FamilyContext, Prop, PropCtx } from './perfScene.ts';

export const NR = 8;
export const ringRadius = (j: number) => 2.4 + j * 1.05;
export const RING_TH = 0.08;
export const BALL_R = 0.2;
const CORE = 0.55;
const EXIT = 11.6;
const GAP_ARC = 1.3;
/** a ring may ease backwards by up to this angle between passes (keeps corrections small) */
const BACKUP = Math.PI / 3;
export const gapHalf = (j: number) => GAP_ARC / ringRadius(j);
const HIGH: VoiceRole[] = ['melody', 'counter'];

const wrap = (a: number) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

/** monotone cubic (Fritsch–Carlson) through (ts, ys) with linear extension */
export function monotoneCubic(ts: number[], ys: number[], slopeBefore: number, slopeAfter: number): (t: number) => number {
  const n = ts.length;
  if (n === 1) return (t) => ys[0] + (t < ts[0] ? slopeBefore : slopeAfter) * (t - ts[0]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (ts[i + 1] - ts[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      m[i] = k * a * d[i];
      m[i + 1] = k * b * d[i];
    }
  }
  // extend linearly with the end slopes so the motion stays velocity-continuous
  void slopeAfter;
  return (t: number) => {
    if (t <= ts[0]) return ys[0] + slopeBefore * (t - ts[0]);
    if (t >= ts[n - 1]) return ys[n - 1] + m[n - 1] * (t - ts[n - 1]);
    const i = Math.max(0, Math.min(n - 2, lastIndexAtOrBefore(ts, t)));
    const h = ts[i + 1] - ts[i];
    const u = (t - ts[i]) / h;
    const h00 = 2 * u * u * u - 3 * u * u + 1;
    const h10 = u * u * u - 2 * u * u + u;
    const h01 = -2 * u * u * u + 3 * u * u;
    const h11 = u * u * u - u * u;
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
  };
}

export interface Crossing {
  ring: number;
  t: number;
  phi: number;
  /** radial speed of the marble as it passes */
  vr: number;
  run: number;
  silent: boolean;
}

export interface RingSolution {
  angle: ((t: number) => number)[];
  crossings: Crossing[];
}

interface Run {
  groups: NoteGroup[];
}

function makeRuns(groups: NoteGroup[]): Run[] {
  // phrases break at rests; long phrases are split into balanced runs of at most NR notes,
  // so no run is a short leftover that would have to pass the outer rings right after another
  const phrases: NoteGroup[][] = [];
  let cur: NoteGroup[] = [];
  for (const g of groups) {
    const prev = cur[cur.length - 1];
    if (cur.length && g.time - prev.time > 0.8) {
      phrases.push(cur);
      cur = [];
    }
    cur.push(g);
  }
  if (cur.length) phrases.push(cur);
  const runs: Run[] = [];
  for (const ph of phrases) {
    const k = Math.ceil(ph.length / NR);
    const size = Math.ceil(ph.length / k);
    for (let i = 0; i < ph.length; i += size) runs.push({ groups: ph.slice(i, i + size) });
  }
  return runs;
}

/** radial knots (time → radius) for one run, including the silent launch through inner rings */
function runKnots(run: Run): { ts: number[]; rs: number[]; start: number } {
  const n = run.groups.length;
  const s = NR - n;
  const tFirst = run.groups[0].time;
  // silent inner rings are crossed at the run's own cadence, so every ring sees the same rhythm
  const ioi = clamp(n > 1 ? run.groups[1].time - tFirst : 0.4, 0.12, 0.6);
  const v = 1.05 / ioi;
  const tR0 = tFirst - s * ioi;
  const ts = [tR0 - (ringRadius(0) - CORE) / v];
  const rs = [CORE];
  for (let j = 0; j < s; j++) {
    ts.push(tFirst - (s - j) * ioi);
    rs.push(ringRadius(j));
  }
  for (let j = 0; j < n; j++) {
    ts.push(run.groups[j].time);
    rs.push(ringRadius(s + j));
  }
  const last = ts[ts.length - 1];
  const vOut = n > 1 ? Math.max(4, (rs[rs.length - 1] - rs[rs.length - 2]) / (ts[ts.length - 1] - ts[ts.length - 2])) : v;
  ts.push(last + (EXIT - rs[rs.length - 1]) / vOut);
  rs.push(EXIT);
  return { ts, rs, start: s };
}

// every ring turns the same way at the same nominal speed: marbles fired at successive angles
// then meet gaps with only small speed modulations (alternating directions were tried and
// needed implausibly fast corrections)
const dirOf = (_j: number) => 1;

export function solveRings(runs: Run[], duration: number, energy: (t: number) => number, phase0 = 0): { sol: RingSolution; phis: number[]; knots: { ts: number[]; rs: number[]; start: number }[] } {
  const reqs: { t: number; th: number }[][] = Array.from({ length: NR }, () => []);
  const crossings: Crossing[] = [];
  const phis: number[] = [];
  const knots = runs.map(runKnots);
  // current unwrapped angle state per ring (time, angle)
  const tStart = Math.min(0, ...knots.map((k) => k.ts[0])) - 1;
  const state = Array.from({ length: NR }, (_, j) => ({ t: tStart, th: j * 0.9 + phase0 * (j + 1) }));
  runs.forEach((_run, ri) => {
    const k = knots[ri];
    const times: { ring: number; t: number; silent: boolean; vr: number }[] = [];
    for (let j = 0; j < NR; j++) {
      // time this run's marble crosses ring j (radius is monotone in time)
      const R = ringRadius(j);
      let i = 0;
      while (i < k.rs.length - 1 && k.rs[i + 1] < R) i++;
      const u = (R - k.rs[i]) / (k.rs[i + 1] - k.rs[i]);
      const t = k.ts[i] + (k.ts[i + 1] - k.ts[i]) * u;
      const vr = (k.rs[i + 1] - k.rs[i]) / (k.ts[i + 1] - k.ts[i]);
      times.push({ ring: j, t, silent: j < k.start, vr });
    }
    // choose the launch angle that keeps every ring's required rotation well inside what its gap
    // can tolerate while the marble is passing (allowed = spare gap angle / pass duration)
    const allowed = times.map((x) => {
      const R = ringRadius(x.ring);
      const halfPass = (RING_TH + BALL_R) / Math.max(0.5, x.vr);
      return Math.max(0.05, (gapHalf(x.ring) - Math.asin(BALL_R / R)) / halfPass);
    });
    let best = 0;
    let bestCost = Infinity;
    for (let c = 0; c < 144; c++) {
      const phi = (c / 144) * TAU;
      let cost = 0;
      times.forEach((x, i) => {
        const st = state[x.ring];
        const dt = Math.max(1e-3, x.t - st.t);
        const delta = ((((phi - st.th + BACKUP) % TAU) + TAU) % TAU) - BACKUP;
        const w = delta / dt;
        cost += (Math.abs(w) / (0.7 * allowed[i])) ** 8 + 0.02 * ((w - energy(x.t)) / energy(x.t)) ** 2;
      });
      if (cost < bestCost) {
        bestCost = cost;
        best = phi;
      }
    }
    phis.push(best);
    for (const x of times) {
      const st = state[x.ring];
      const delta = ((((best - st.th + BACKUP) % TAU) + TAU) % TAU) - BACKUP;
      st.th += delta;
      st.t = x.t;
      reqs[x.ring].push({ t: x.t, th: st.th });
      crossings.push({ ring: x.ring, t: x.t, phi: best, vr: x.vr, run: ri, silent: x.silent });
    }
  });
  const angle = reqs.map((rq, j) => {
    const d = dirOf(j);
    const w0 = energy(0) * d;
    const ts = [tStart, ...rq.map((r) => r.t)];
    const ys = [j * 0.9 + phase0 * (j + 1), ...rq.map((r) => r.th)];
    // drop requirements that collide in time (cannot happen for one ring, but stay safe)
    const fts: number[] = [];
    const fys: number[] = [];
    ts.forEach((t, i) => {
      if (fts.length && t - fts[fts.length - 1] < 1e-4) return;
      fts.push(t);
      fys.push(ys[i]);
    });
    return monotoneCubic(fts, fys, w0, energy(duration) * d);
  });
  return { sol: { angle, crossings }, phis, knots };
}

/** Clearance check: while the marble is inside a ring's band, it must be inside the gap. */
export function gapProblems(sol: RingSolution): string[] {
  const out: string[] = [];
  for (const c of sol.crossings) {
    const R = ringRadius(c.ring);
    const halfPass = (RING_TH + BALL_R) / Math.max(0.5, c.vr);
    const ballAng = Math.asin(BALL_R / R);
    for (let k = -4; k <= 4; k++) {
      const t = c.t + (halfPass * k) / 4;
      const off = Math.abs(wrap(c.phi - sol.angle[c.ring](t)));
      if (off + ballAng > gapHalf(c.ring) + 1e-3) {
        out.push(`ring ${c.ring} closes on marble ${c.run} at ${t.toFixed(3)} (off ${off.toFixed(3)} rad)`);
        break;
      }
    }
  }
  return out;
}

const supportCache = new Map<string, string | null>();

function prepare(notes: TimedNote[]) {
  const high = groupNotes(notes.filter((n) => HIGH.includes(n.voice)));
  const runs = makeRuns(high);
  const last = notes.length ? notes[notes.length - 1].time : 1;
  const energy = (t: number) => 0.5 + 0.8 * clamp(t / last, 0, 1);
  // the fastest marble: one ring spacing per inter-onset interval
  let minIoi = Infinity;
  for (let i = 1; i < high.length; i++) minIoi = Math.min(minIoi, high[i].time - high[i - 1].time);
  return { runs, energy, last, maxRadial: 1.05 / minIoi };
}

/** solve with a few different starting ring phases and keep the cleanest solution */
function bestSolve(runs: Run[], duration: number, energy: (t: number) => number) {
  let best: ReturnType<typeof solveRings> | null = null;
  let bestN = Infinity;
  for (let attempt = 0; attempt < 16 && bestN > 0; attempt++) {
    const s = solveRings(runs, duration, energy, attempt * 0.618);
    const n = gapProblems(s.sol).length;
    if (n < bestN) {
      best = s;
      bestN = n;
    }
  }
  return best!;
}

const MAX_RADIAL = 18;

export const ringsFamily: Family = {
  id: 'rings',
  title: 'Ring Escape',
  blurb: 'Every phrase is a marble fired from the core through concentric rotating rings. Each note is the marble slipping through a ring’s gap; the rings turn faster and glow brighter as the music builds. Bass pendulums strike below.',
  motion: 'Choreographed performance · rotating rings solved so real gaps meet every marble on its note',
  defaultSong: 'mountain-king',
  defaultVoicing: 'classic',
  leadIn: 3.6,
  supports(score: ScoreData): string | null {
    const hit = supportCache.get(score.id);
    if (hit !== undefined) return hit;
    const { runs, energy, last, maxRadial } = prepare(timeNotes(score, 1, 3.6));
    let res: string | null = null;
    if (maxRadial > MAX_RADIAL) res = `notes too close together for ring crossings (needs ${maxRadial.toFixed(0)} units/s)`;
    else {
      const probs = gapProblems(bestSolve(runs, last + 3, energy).sol);
      if (probs.length) res = `rings cannot open fast enough for this piece (${probs.length} tight passes)`;
    }
    supportCache.set(score.id, res);
    return res;
  },
  build(notes: TimedNote[], ctx: FamilyContext): Choreography {
    const b = newBuilder(ctx.voicing);
    const props: Prop[] = [];
    const { runs, energy, last } = prepare(notes);
    const { sol, phis, knots } = bestSolve(runs, last + 3, energy);
    b.problems.push(...gapProblems(sol));
    runs.forEach((run, ri) => {
      const k = knots[ri];
      const phi = phis[ri];
      const dx = Math.cos(phi);
      const dy = Math.sin(phi);
      const path = new Path([
        { x: dx * CORE, y: dy * CORE },
        { x: dx * EXIT, y: dy * EXIT },
      ]);
      const id = `rg:b${ri}`;
      const segs: Segment[] = [
        { kind: 'hold', t0: k.ts[0] - 0.3, t1: k.ts[0], x: dx * CORE, y: dy * CORE },
        { kind: 'knots', t0: k.ts[0], t1: k.ts[k.ts.length - 1], path, ts: k.ts, ss: k.rs.map((r) => r - CORE) },
      ];
      const voice: VoiceRole = run.groups[0].notes.some((n) => n.voice === 'melody') ? 'melody' : 'counter';
      b.balls.push({ id, r: BALL_R, voice, segs, fadeIn: 0.25, fadeOut: 0.45, hits: run.groups.map((g) => g.time) });
      run.groups.forEach((g, j) => {
        const ring = k.start + j;
        const R = ringRadius(ring);
        b.acts.push({
          time: g.time,
          target: `rg:ring${ring}`,
          notes: g.notes.map((n) => ({ pitch: n.pitch, vel: n.vel, dur: n.dur, inst: ctx.voicing[n.voice] })),
          x: dx * R,
          y: dy * R,
          nx: dx,
          ny: dy,
          voice,
          ball: id,
          label: g.notes.map((n) => noteName(n.pitch)).join('·'),
        });
      });
    });
    const low = notes.filter((n) => !HIGH.includes(n.voice));
    pendulumRow(b, low, { id: 'rg:bass', voice: 'bass', x0: -7.5, x1: 7.5, pivotY: -12.3, length: 1.6 });
    // rings
    for (let j = 0; j < NR; j++) {
      const R = ringRadius(j);
      const target = `rg:ring${j}`;
      const gh = gapHalf(j);
      const ang = sol.angle[j];
      props.push({
        id: target,
        draw(dl: DrawList, t: number, c: PropCtx) {
          const f = c.flash(target, t, 0.22);
          const e = clamp((energy(t) - 0.5) / 0.8, 0, 1);
          const col = j % 2 ? c.pal.track : c.pal.accent;
          const g = ang(t);
          dl.arc(0, 0, R, RING_TH + f * 0.03, g + gh, TAU - 2 * gh, col, 0.75 + f * 0.25, 0.08 + e * 0.18 + f * 0.3);
          // gap markers
          dl.disc(Math.cos(g + gh) * R, Math.sin(g + gh) * R, 0.07, c.pal.text, 0.7);
          dl.disc(Math.cos(g - gh) * R, Math.sin(g - gh) * R, 0.07, c.pal.text, 0.7);
          if (f > 0.03) {
            const cr = sol.crossings.find((x) => x.ring === j && Math.abs(x.t - (t - c.since(target, t))) < 1e-6);
            const a = cr ? cr.phi : g;
            dl.glow(Math.cos(a) * R, Math.sin(a) * R, 1.3, c.voiceColor('melody'), f * 0.7);
            if (c.labels && cr) {
              const act = b.acts.find((x) => x.target === target && Math.abs(x.time - cr.t) < 1e-6);
              if (act) dl.text(act.label, Math.cos(a) * (R + 0.5), Math.sin(a) * (R + 0.5), 0.24, c.pal.text, f, 'center');
            }
          }
        },
      });
    }
    const launches = knots.map((k) => k.ts[0]);
    props.push({
      id: 'rg:core',
      layer: 'front',
      draw(dl: DrawList, t: number, c: PropCtx) {
        const i = lastIndexAtOrBefore(launches, t + 0.3);
        const pulse = i >= 0 ? Math.exp(-Math.abs(t - launches[i]) / 0.25) : 0;
        const e = clamp((energy(t) - 0.5) / 0.8, 0, 1);
        dl.glow(0, 0, 2.4 + pulse, c.pal.accent, 0.35 + e * 0.3 + pulse * 0.4);
        dl.disc(0, 0, CORE + 0.12, c.pal.bgTop, 1);
        dl.ring(0, 0, CORE + 0.1, 0.06, c.pal.accent, 1, 0.2 + pulse * 0.4);
      },
    });
    props.unshift({
      id: 'rg:halo',
      layer: 'back',
      draw(dl: DrawList, t: number, c: PropCtx) {
        const e = clamp((energy(t) - 0.5) / 0.8, 0, 1);
        dl.ring(0, 0, EXIT, 0.03, c.pal.grid, 0.6 + e * 0.4, 0.1 + e * 0.3);
      },
    });
    return {
      balls: b.balls,
      props: [...props, ...b.props],
      acts: b.acts,
      duration: last + 3,
      bounds: { minX: -EXIT - 0.6, minY: -14.6, maxX: EXIT + 0.6, maxY: EXIT + 0.6 },
      maxSpeed: 20,
      contactTol: 0.02,
      problems: b.problems,
    };
  },
};
