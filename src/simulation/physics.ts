// Deterministic 2D physics for circles ("balls") against segments, circles and arcs.
// Fixed timestep with bounded substeps sized from the fastest ball, penetration
// correction, restitution/friction, kinematic (moving/rotating) colliders, sensors,
// and contact-*entry* events with hysteresis so resting contact never retriggers.

import { TAU, clamp, closestOnSegment } from '../core/math.ts';

export type ContactSound = 'musical' | 'mechanical' | 'silent';

export type ColliderShape =
  | { type: 'segment'; ax: number; ay: number; bx: number; by: number; thickness: number }
  | { type: 'circle'; x: number; y: number; r: number }
  | { type: 'arc'; x: number; y: number; radius: number; thickness: number; start: number; sweep: number };

export interface KinematicBody {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  omega: number;
}

export interface Collider {
  id: number;
  shape: ColliderShape;
  body: KinematicBody | null;
  restitution: number;
  friction: number;
  /** extra normal speed added on impact (bumpers) */
  kick: number;
  sensor: boolean;
  sound: ContactSound;
  enabled: boolean;
  tag: string;
  userData: unknown;
}

export interface Ball {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** visual spin angle, integrated from tangential motion */
  spin: number;
  hue: number;
  age: number;
  generation: number;
  alive: boolean;
  /** collider ids / (BALL_KEY + ball id) currently in contact */
  touching: Set<number>;
  userData: unknown;
}

export interface ContactEvent {
  ball: Ball;
  collider: Collider | null;
  other: Ball | null;
  x: number;
  y: number;
  nx: number;
  ny: number;
  /** normal approach speed at impact (world units / s) */
  speed: number;
  time: number;
}

export interface WorldParams {
  gravityX: number;
  gravityY: number;
  restitution: number;
  friction: number;
  /** velocity damping per second (air) */
  damping: number;
  maxSpeed: number;
  ballCollisions: boolean;
  killY: number;
}

export const BALL_KEY = 1 << 24;
export const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 12;
const EXIT_MARGIN = 0.035;

export function defaultWorldParams(): WorldParams {
  return { gravityX: 0, gravityY: -9.8, restitution: 0.72, friction: 0.08, damping: 0.02, maxSpeed: 40, ballCollisions: true, killY: -60 };
}

interface Closest {
  // closest point on collider surface centreline (world) and outward normal toward the ball
  px: number;
  py: number;
  nx: number;
  ny: number;
  d: number;
  thick: number;
}

const tmp: Closest = { px: 0, py: 0, nx: 0, ny: 1, d: 0, thick: 0 };

export class World {
  params: WorldParams;
  balls: Ball[] = [];
  colliders: Collider[] = [];
  events: ContactEvent[] = [];
  time = 0;
  stepCount = 0;
  private nextBallId = 1;
  private nextColliderId = 1;
  private pool: Ball[] = [];
  private order: Ball[] = [];

  constructor(params: Partial<WorldParams> = {}) {
    this.params = { ...defaultWorldParams(), ...params };
  }

  addCollider(shape: ColliderShape, opts: Partial<Omit<Collider, 'id' | 'shape'>> = {}): Collider {
    const c: Collider = {
      id: this.nextColliderId++,
      shape,
      body: opts.body ?? null,
      restitution: opts.restitution ?? 1,
      friction: opts.friction ?? 1,
      kick: opts.kick ?? 0,
      sensor: opts.sensor ?? false,
      sound: opts.sound ?? 'mechanical',
      enabled: opts.enabled ?? true,
      tag: opts.tag ?? '',
      userData: opts.userData ?? null,
    };
    this.colliders.push(c);
    return c;
  }

  removeCollider(c: Collider): void {
    const i = this.colliders.indexOf(c);
    if (i >= 0) this.colliders.splice(i, 1);
    for (const b of this.balls) b.touching.delete(c.id);
  }

  clearColliders(): void {
    this.colliders.length = 0;
  }

  addBall(x: number, y: number, r: number, vx = 0, vy = 0, hue = 0, generation = 0): Ball {
    const b = this.pool.pop() ?? { id: 0, x: 0, y: 0, vx: 0, vy: 0, r: 0, spin: 0, hue: 0, age: 0, generation: 0, alive: true, touching: new Set<number>(), userData: null };
    b.id = this.nextBallId++;
    b.x = x;
    b.y = y;
    b.vx = vx;
    b.vy = vy;
    b.r = r;
    b.spin = 0;
    b.hue = hue;
    b.age = 0;
    b.generation = generation;
    b.alive = true;
    b.touching.clear();
    b.userData = null;
    this.balls.push(b);
    return b;
  }

  removeBall(b: Ball): void {
    if (!b.alive) return;
    b.alive = false;
    const i = this.balls.indexOf(b);
    if (i >= 0) this.balls.splice(i, 1);
    for (const o of this.balls) o.touching.delete(BALL_KEY + b.id);
    this.pool.push(b);
  }

  clearBalls(): void {
    for (const b of this.balls) {
      b.alive = false;
      this.pool.push(b);
    }
    this.balls.length = 0;
  }

  /** Reset ids/time so a rebuilt scene is bit-for-bit reproducible. */
  resetCounters(): void {
    this.nextBallId = 1;
    this.nextColliderId = 1;
    this.time = 0;
    this.stepCount = 0;
    this.events.length = 0;
  }

  /** true if a circle at (x,y,r) overlaps no ball and no solid collider */
  isFree(x: number, y: number, r: number, ignore?: Ball): boolean {
    for (const b of this.balls) {
      if (b === ignore) continue;
      const dx = b.x - x;
      const dy = b.y - y;
      const rr = b.r + r;
      if (dx * dx + dy * dy < rr * rr) return false;
    }
    for (const c of this.colliders) {
      if (!c.enabled || c.sensor) continue;
      closest(c, x, y, tmp);
      if (tmp.d < r + tmp.thick) return false;
    }
    return true;
  }

  /** One fixed step (FIXED_DT). Contact-entry events are appended to `events`. */
  step(dt = FIXED_DT): void {
    const p = this.params;
    let maxV = 0;
    let minR = Infinity;
    for (const b of this.balls) {
      const v = Math.abs(b.vx) + Math.abs(b.vy);
      if (v > maxV) maxV = v;
      if (b.r < minR) minR = b.r;
    }
    let maxOmegaR = 0;
    for (const c of this.colliders) if (c.body) maxOmegaR = Math.max(maxOmegaR, Math.abs(c.body.omega) * 8 + Math.abs(c.body.vx) + Math.abs(c.body.vy));
    const travel = (maxV + maxOmegaR) * dt;
    const n = clamp(Math.ceil(travel / Math.max(0.02, minR * 0.45)), 1, MAX_SUBSTEPS);
    const h = dt / n;
    const damp = Math.max(0, 1 - p.damping * h);

    for (let s = 0; s < n; s++) {
      for (const b of this.balls) {
        b.vx = (b.vx + p.gravityX * h) * damp;
        b.vy = (b.vy + p.gravityY * h) * damp;
        const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        if (sp > p.maxSpeed) {
          b.vx *= p.maxSpeed / sp;
          b.vy *= p.maxSpeed / sp;
        }
        b.x += b.vx * h;
        b.y += b.vy * h;
        b.spin += (b.vx * h) / Math.max(0.01, b.r);
      }
      // kinematic bodies are advanced by their owners between steps; colliders are resolved per substep
      for (let iter = 0; iter < 2; iter++) {
        for (const b of this.balls) this.resolveColliders(b);
        if (p.ballCollisions && iter === 0) this.resolveBalls();
      }
    }

    // contact exit with hysteresis
    for (const b of this.balls) {
      if (b.touching.size === 0) continue;
      for (const key of b.touching) {
        if (key >= BALL_KEY) {
          const o = this.findBall(key - BALL_KEY);
          if (!o || Math.hypot(o.x - b.x, o.y - b.y) > o.r + b.r + EXIT_MARGIN * 2) b.touching.delete(key);
        } else {
          const c = this.findCollider(key);
          if (!c || !c.enabled) {
            b.touching.delete(key);
            continue;
          }
          closest(c, b.x, b.y, tmp);
          if (tmp.d > b.r + tmp.thick + EXIT_MARGIN) b.touching.delete(key);
        }
      }
    }

    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.age += dt;
      if (b.y < p.killY || !Number.isFinite(b.x) || !Number.isFinite(b.y)) this.removeBall(b);
    }
    this.time += dt;
    this.stepCount++;
  }

  private findBall(id: number): Ball | undefined {
    for (const b of this.balls) if (b.id === id) return b;
    return undefined;
  }

  private findCollider(id: number): Collider | undefined {
    for (const c of this.colliders) if (c.id === id) return c;
    return undefined;
  }

  private resolveColliders(b: Ball): void {
    const p = this.params;
    for (const c of this.colliders) {
      if (!c.enabled) continue;
      closest(c, b.x, b.y, tmp);
      const reach = b.r + tmp.thick;
      if (tmp.d >= reach) continue;
      let nx = tmp.nx;
      let ny = tmp.ny;
      // velocity of the collider surface at the contact point
      let cvx = 0;
      let cvy = 0;
      if (c.body) {
        const rx = tmp.px - c.body.x;
        const ry = tmp.py - c.body.y;
        cvx = c.body.vx - c.body.omega * ry;
        cvy = c.body.vy + c.body.omega * rx;
      }
      const rvx = b.vx - cvx;
      const rvy = b.vy - cvy;
      const vn = rvx * nx + rvy * ny;
      if (c.sensor) {
        if (!b.touching.has(c.id)) {
          b.touching.add(c.id);
          this.events.push({ ball: b, collider: c, other: null, x: tmp.px, y: tmp.py, nx, ny, speed: Math.hypot(rvx, rvy), time: this.time });
        }
        continue;
      }
      if (tmp.d < 1e-9) {
        nx = 0;
        ny = 1;
      }
      const pen = reach - tmp.d;
      b.x += nx * pen;
      b.y += ny * pen;
      if (vn < 0) {
        const e = clamp(p.restitution * c.restitution, 0, 1.25);
        const tvx = rvx - vn * nx;
        const tvy = rvy - vn * ny;
        const tl = Math.hypot(tvx, tvy);
        const newVn = -vn * e + c.kick;
        const fr = p.friction * c.friction;
        const drop = Math.min(tl, fr * (newVn - vn));
        const k = tl > 1e-9 ? (tl - drop) / tl : 0;
        b.vx = cvx + tvx * k + nx * newVn;
        b.vy = cvy + tvy * k + ny * newVn;
        if (!b.touching.has(c.id)) {
          b.touching.add(c.id);
          this.events.push({ ball: b, collider: c, other: null, x: b.x - nx * b.r, y: b.y - ny * b.r, nx, ny, speed: -vn, time: this.time });
        } else b.touching.add(c.id);
      } else b.touching.add(c.id);
    }
  }

  private resolveBalls(): void {
    const arr = this.order;
    arr.length = 0;
    for (const b of this.balls) arr.push(b);
    // insertion sort by left edge (nearly sorted between substeps) — deterministic tie-break on id
    for (let i = 1; i < arr.length; i++) {
      const v = arr[i];
      const key = v.x - v.r;
      let j = i - 1;
      while (j >= 0 && (arr[j].x - arr[j].r > key || (arr[j].x - arr[j].r === key && arr[j].id > v.id))) {
        arr[j + 1] = arr[j];
        j--;
      }
      arr[j + 1] = v;
    }
    const e = this.params.restitution;
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      const right = a.x + a.r;
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j];
        if (b.x - b.r > right) break;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const rr = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 1e-6;
        const nx = d2 > 0 ? dx / d : 1;
        const ny = d2 > 0 ? dy / d : 0;
        const ma = a.r * a.r;
        const mb = b.r * b.r;
        const inv = 1 / (ma + mb);
        const pen = rr - d;
        a.x -= nx * pen * mb * inv;
        a.y -= ny * pen * mb * inv;
        b.x += nx * pen * ma * inv;
        b.y += ny * pen * ma * inv;
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        const key = BALL_KEY + b.id;
        if (vn < 0) {
          const jimp = (-(1 + e) * vn * ma * mb) * inv;
          a.vx -= (jimp / ma) * nx;
          a.vy -= (jimp / ma) * ny;
          b.vx += (jimp / mb) * nx;
          b.vy += (jimp / mb) * ny;
          if (!a.touching.has(key)) {
            this.events.push({ ball: a, collider: null, other: b, x: a.x + nx * a.r, y: a.y + ny * a.r, nx, ny, speed: -vn, time: this.time });
          }
        }
        a.touching.add(key);
        b.touching.add(BALL_KEY + a.id);
      }
    }
  }
}

/** Closest point on a collider's centreline to (x, y), in world space, with normal toward the point. */
export function closest(c: Collider, x: number, y: number, out: Closest): Closest {
  let lx = x;
  let ly = y;
  let cos = 1;
  let sin = 0;
  const body = c.body;
  if (body) {
    cos = Math.cos(body.angle);
    sin = Math.sin(body.angle);
    const dx = x - body.x;
    const dy = y - body.y;
    lx = dx * cos + dy * sin;
    ly = -dx * sin + dy * cos;
  }
  const s = c.shape;
  let px: number;
  let py: number;
  let thick: number;
  if (s.type === 'segment') {
    const t = closestOnSegment(lx, ly, s.ax, s.ay, s.bx, s.by);
    px = s.ax + (s.bx - s.ax) * t;
    py = s.ay + (s.by - s.ay) * t;
    thick = s.thickness;
  } else if (s.type === 'circle') {
    px = s.x;
    py = s.y;
    thick = s.r;
  } else {
    const dx = lx - s.x;
    const dy = ly - s.y;
    let a = Math.atan2(dy, dx) - s.start;
    a = ((a % TAU) + TAU) % TAU;
    if (a <= s.sweep) {
      const ang = s.start + a;
      px = s.x + Math.cos(ang) * s.radius;
      py = s.y + Math.sin(ang) * s.radius;
    } else {
      // nearest end cap
      const e0x = s.x + Math.cos(s.start) * s.radius;
      const e0y = s.y + Math.sin(s.start) * s.radius;
      const e1x = s.x + Math.cos(s.start + s.sweep) * s.radius;
      const e1y = s.y + Math.sin(s.start + s.sweep) * s.radius;
      if ((lx - e0x) ** 2 + (ly - e0y) ** 2 < (lx - e1x) ** 2 + (ly - e1y) ** 2) {
        px = e0x;
        py = e0y;
      } else {
        px = e1x;
        py = e1y;
      }
    }
    thick = s.thickness;
  }
  let nx = lx - px;
  let ny = ly - py;
  const d = Math.sqrt(nx * nx + ny * ny);
  if (d > 1e-9) {
    nx /= d;
    ny /= d;
  } else if (s.type === 'segment') {
    const sx = s.bx - s.ax;
    const sy = s.by - s.ay;
    const sl = Math.hypot(sx, sy) || 1;
    nx = -sy / sl;
    ny = sx / sl;
  } else {
    nx = 0;
    ny = 1;
  }
  if (body) {
    out.px = body.x + px * cos - py * sin;
    out.py = body.y + px * sin + py * cos;
    out.nx = nx * cos - ny * sin;
    out.ny = nx * sin + ny * cos;
  } else {
    out.px = px;
    out.py = py;
    out.nx = nx;
    out.ny = ny;
  }
  out.d = d;
  out.thick = thick;
  return out;
}

/** Order-independent fingerprint of the world state, for determinism tests. */
export function worldHash(w: World): string {
  let h = 0;
  for (const b of w.balls) {
    h = (h * 31 + Math.round(b.x * 1e4)) | 0;
    h = (h * 31 + Math.round(b.y * 1e4)) | 0;
    h = (h * 31 + Math.round(b.vx * 1e4)) | 0;
    h = (h * 31 + Math.round(b.vy * 1e4)) | 0;
  }
  return `${w.balls.length}:${h}`;
}
