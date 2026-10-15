// PERFORMANCE · Musical Maze: two seeded perfect mazes (melody above,
// accompaniment below). A marble tours every corridor of its maze — into each
// dead end and back — at constant speed, sounding glowing note gates placed
// exactly where it will be at each note's time. Timed doors across some
// corridors swing open only while a marble passes; routes are designed from the
// maze's spanning tree, so there is always a way through and nothing is ever
// struck except the gates.
import { clamp } from '../../core/math.ts';
import { Rng } from '../../core/rng.ts';
import { Path, type Pt } from '../../choreography/core.ts';
import { groupNotes, newBuilder, pathRide } from '../../choreography/mechanisms.ts';
import type { TimedNote, VoiceRole } from '../../music/score.ts';
import type { DrawList } from '../../rendering/draw.ts';
import type { Choreography, Family, FamilyContext, Prop, PropCtx } from './perfScene.ts';

const HIGH: VoiceRole[] = ['melody', 'counter'];

export interface Maze {
  cols: number;
  rows: number;
  cell: number;
  x0: number;
  y0: number;
  /** open passages between cells: key `${a}-${b}` with a < b */
  open: Set<string>;
  /** Euler tour of the spanning tree from the entrance cell (cell indices) */
  tour: number[];
}

const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

export function makeMaze(cols: number, rows: number, cell: number, x0: number, y0: number, rng: Rng): Maze {
  const n = cols * rows;
  const seen = new Uint8Array(n);
  const open = new Set<string>();
  const tour: number[] = [];
  const start = 0;
  // iterative randomized DFS producing the spanning tree and its Euler tour
  const stack: { c: number; nbrs: number[] }[] = [];
  const nbrsOf = (c: number) => {
    const x = c % cols;
    const y = Math.floor(c / cols);
    const out: number[] = [];
    if (x > 0) out.push(c - 1);
    if (x < cols - 1) out.push(c + 1);
    if (y > 0) out.push(c - cols);
    if (y < rows - 1) out.push(c + cols);
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  seen[start] = 1;
  stack.push({ c: start, nbrs: nbrsOf(start) });
  tour.push(start);
  while (stack.length) {
    const top = stack[stack.length - 1];
    const next = top.nbrs.find((x) => !seen[x]);
    if (next === undefined) {
      stack.pop();
      if (stack.length) tour.push(stack[stack.length - 1].c);
      continue;
    }
    top.nbrs = top.nbrs.filter((x) => x !== next);
    seen[next] = 1;
    open.add(key(top.c, next));
    tour.push(next);
    stack.push({ c: next, nbrs: nbrsOf(next) });
  }
  return { cols, rows, cell, x0, y0, open, tour };
}

export function cellCenter(m: Maze, c: number): Pt {
  return { x: m.x0 + ((c % m.cols) + 0.5) * m.cell, y: m.y0 - (Math.floor(c / m.cols) + 0.5) * m.cell };
}

/** smooth route through cell centres: corners are rounded with short arcs */
function routePath(m: Maze, entry: Pt, exit: Pt): Path {
  const raw: Pt[] = [entry, ...m.tour.map((c) => cellCenter(m, c)), exit];
  const pts: Pt[] = [];
  const rad = m.cell * 0.32;
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    if (i === 0 || i === raw.length - 1) {
      pts.push(p);
      continue;
    }
    const a = raw[i - 1];
    const b = raw[i + 1];
    const d1 = { x: p.x - a.x, y: p.y - a.y };
    const d2 = { x: b.x - p.x, y: b.y - p.y };
    const l1 = Math.hypot(d1.x, d1.y) || 1;
    const l2 = Math.hypot(d2.x, d2.y) || 1;
    const dot = (d1.x * d2.x + d1.y * d2.y) / (l1 * l2);
    if (dot > 0.99) {
      pts.push(p);
      continue;
    }
    if (dot < -0.99) {
      // dead end: run to near the wall and turn back (the marble kisses the end wall)
      const ux = d1.x / l1;
      const uy = d1.y / l1;
      const reach = m.cell * 0.5 - 0.28;
      pts.push({ x: p.x + ux * reach, y: p.y + uy * reach });
      continue;
    }
    // quadratic corner from p - rad·u1 to p + rad·u2
    const s = { x: p.x - (d1.x / l1) * rad, y: p.y - (d1.y / l1) * rad };
    const e = { x: p.x + (d2.x / l2) * rad, y: p.y + (d2.y / l2) * rad };
    for (let k = 0; k <= 6; k++) {
      const u = k / 6;
      pts.push({ x: (1 - u) * (1 - u) * s.x + 2 * u * (1 - u) * p.x + u * u * e.x, y: (1 - u) * (1 - u) * s.y + 2 * u * (1 - u) * p.y + u * u * e.y });
    }
  }
  // densify straight runs so speed sampling is smooth
  const dense: Pt[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.2));
    for (let k = 0; k < n; k++) dense.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  dense.push(pts[pts.length - 1]);
  return new Path(dense);
}

function mazeWalls(m: Maze): [number, number, number, number][] {
  const w: [number, number, number, number][] = [];
  const { cols, rows, cell, x0, y0 } = m;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const c = y * cols + x;
      const L = x0 + x * cell;
      const T = y0 - y * cell;
      if (x < cols - 1 && !m.open.has(key(c, c + 1))) w.push([L + cell, T, L + cell, T - cell]);
      if (y < rows - 1 && !m.open.has(key(c, c + cols))) w.push([L, T - cell, L + cell, T - cell]);
    }
  // outer frame with an entrance gap above the top-left cell
  const W = cols * cell;
  const H = rows * cell;
  w.push([x0 + cell, y0, x0 + W, y0]);
  w.push([x0, y0 - H, x0 + W, y0 - H]);
  w.push([x0, y0, x0, y0 - H]);
  w.push([x0 + W, y0, x0 + W, y0 - H]);
  return w;
}

interface Door {
  id: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  windows: [number, number][];
}

function buildMaze(b: ReturnType<typeof newBuilder>, notes: TimedNote[], id: string, voice: VoiceRole, x0: number, y0: number, maxW: number, maxH: number, rng: Rng, props: Prop[], doorsOut: Door[]): { w: number; h: number } {
  const groups = groupNotes(notes);
  if (!groups.length) return { w: 0, h: 0 };
  const span = groups[groups.length - 1].time - groups[0].time;
  // size the maze so the full tour takes the passage's duration at a lively, readable speed
  const targetV = clamp((groups.length / Math.max(1, span)) * 0.75, 2.2, 6);
  let cell = 1.05;
  let cells = Math.max(6, Math.round((targetV * span) / (2 * cell)) + 1);
  let cols = Math.max(3, Math.round(Math.sqrt(cells * (maxW / maxH))));
  let rows = Math.max(2, Math.ceil(cells / cols));
  // shrink cells if the grid would not fit the region
  const fit = Math.min(maxW / (cols * cell), maxH / (rows * cell), 1);
  if (fit < 1) {
    cell *= fit;
    cells = Math.max(6, Math.round((targetV * span) / (2 * cell)) + 1);
    cols = Math.max(3, Math.floor(maxW / cell));
    rows = Math.max(2, Math.min(Math.floor(maxH / cell), Math.ceil(cells / cols)));
  }
  const mx0 = x0 - (cols * cell) / 2;
  const m = makeMaze(cols, rows, cell, mx0, y0, rng);
  const first = cellCenter(m, 0);
  const entry = { x: first.x, y: y0 + 1.2 };
  // the tour ends back in the entrance cell: the marble leaves the way it came in
  const exit = { x: first.x, y: y0 + 1.6 };
  const path = routePath(m, entry, exit);
  const ride = pathRide(b, notes, { id, voice, r: Math.min(0.2, cell * 0.2), path, gateFrom: 1.1, gateTo: path.length - 1.2, style: 'gate', trackWidth: 0.04, drawTrack: false });
  const walls = mazeWalls(m);
  props.push({
    id: `${id}:walls`,
    layer: 'back',
    draw(dl: DrawList, t: number, c: PropCtx) {
      const col = c.voiceColor(voice);
      const pulse = 0.12 + 0.12 * Math.max(0, Math.sin(t * 2));
      dl.rect(x0, y0 - (rows * cell) / 2, (cols * cell) / 2 + 0.12, (rows * cell) / 2 + 0.12, 0, c.pal.bgTop, 0.5, 0.15);
      for (const [ax, ay, bx, by] of walls) dl.line(ax, ay, bx, by, 0.05, col, 0.55, pulse);
      dl.line(entry.x, entry.y, first.x, y0, 0.03, c.pal.dim, 0.5);
    },
  });
  // timed doors on a few tree passages; each is open only around the marble's passes
  const tAt = (s: number) => ride.t0 + (s - ride.gateFrom) / ride.speed;
  const passages = [...m.open].filter((_, i) => i % Math.max(3, Math.floor(m.open.size / 6)) === 1).slice(0, 7);
  for (const k of passages) {
    const [a, c2] = k.split('-').map(Number);
    const pa = cellCenter(m, a);
    const pb = cellCenter(m, c2);
    const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    const horiz = Math.abs(pa.x - pb.x) > 0.01;
    // find the route's crossings of this passage midline
    const windows: [number, number][] = [];
    const step = 0.05;
    let prevD = Infinity;
    for (let s = 0; s <= path.length; s += step) {
      const p = path.at(s);
      const d = Math.hypot(p.x - mid.x, p.y - mid.y);
      if (d < 0.08 && prevD >= 0.08 && s >= ride.gateFrom && s <= ride.gateEnd) {
        const t = tAt(s);
        windows.push([t - 0.55, t + 0.45]);
      }
      prevD = d;
    }
    if (!windows.length) continue;
    for (const [w0] of windows) b.mech.push({ time: w0 - 0.15, kind: 'clack', vel: 0.45, x: mid.x });
    const h = cell * 0.5;
    const door: Door = horiz
      ? { id: `${id}:door${k}`, ax: mid.x, ay: mid.y + h, bx: mid.x, by: mid.y - h, windows }
      : { id: `${id}:door${k}`, ax: mid.x - h, ay: mid.y, bx: mid.x + h, by: mid.y, windows };
    doorsOut.push(door);
    props.push({
      id: door.id,
      draw(dl: DrawList, t: number, c: PropCtx) {
        let open = 0;
        for (const [w0, w1] of door.windows) {
          if (t >= w0 - 0.3 && t <= w1 + 0.3) open = Math.max(open, clamp(Math.min(t - (w0 - 0.3), w1 + 0.3 - t) / 0.3, 0, 1));
        }
        // the door leaf swings about its first hinge
        const ang = open * 1.45;
        const dx = door.bx - door.ax;
        const dy = door.by - door.ay;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        const ex = door.ax + (dx * ca - dy * sa) * 0.92;
        const ey = door.ay + (dx * sa + dy * ca) * 0.92;
        dl.line(door.ax, door.ay, ex, ey, 0.06, c.pal.accent, 0.95, 0.1 + open * 0.2);
        dl.disc(door.ax, door.ay, 0.07, c.pal.text, 0.9);
      },
    });
  }
  return { w: cols * cell, h: rows * cell };
}

export const mazeFamily: Family = {
  id: 'maze',
  title: 'Musical Maze',
  blurb: 'Two glowing mazes: the melody marble explores the upper one, the accompaniment marble the lower. Each tours every corridor, sounding note gates placed exactly where it will be on each beat; timed doors swing open just as a marble arrives.',
  motion: 'Choreographed performance · designed routes through seeded mazes, constant-speed rails, timed doors',
  defaultSong: 'rondo-alla-turca',
  defaultVoicing: 'mallets',
  leadIn: 1.8,
  supports: () => null,
  build(notes: TimedNote[], ctx: FamilyContext): Choreography {
    const b = newBuilder(ctx.voicing);
    const props: Prop[] = [];
    const doors: Door[] = [];
    const high = notes.filter((n) => HIGH.includes(n.voice));
    const low = notes.filter((n) => !HIGH.includes(n.voice));
    const W = 17;
    const H = 9.5;
    const rngA = new Rng(ctx.rng.int(1, 1e9));
    const rngB = new Rng(ctx.rng.int(1, 1e9));
    const top = buildMaze(b, high, 'mz:hi', 'melody', 0, H + 0.6, W, H, rngA, props, doors);
    const bot = buildMaze(b, low, 'mz:lo', 'bass', 0, -1.4, W, H, rngB, props, doors);
    props.push({
      id: 'mz:labels',
      layer: 'back',
      draw(dl: DrawList, _t: number, c: PropCtx) {
        if (top.h) dl.text('MELODY', -top.w / 2, H + 2.25, 0.36, c.pal.dim, 0.8, 'left');
        if (bot.h) dl.text('ACCOMPANIMENT', -bot.w / 2, -0.2, 0.36, c.pal.dim, 0.8, 'left');
      },
    });
    const last = notes.length ? notes[notes.length - 1].time : 0;
    const ch: Choreography & { doors?: Door[] } = {
      balls: b.balls,
      props: [...props, ...b.props],
      acts: b.acts,
      duration: last + 3,
      bounds: { minX: -W / 2 - 0.6, minY: -1.4 - Math.max(bot.h, 1) - 0.8, maxX: W / 2 + 0.6, maxY: H + 2.8 },
      maxSpeed: 12,
      contactTol: 0.02,
      problems: b.problems,
      mech: b.mech,
    };
    ch.doors = doors;
    return ch;
  },
};
