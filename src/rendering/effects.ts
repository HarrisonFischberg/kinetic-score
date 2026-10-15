// Pooled particles and time-based trails. Both are bounded: fixed particle
// capacity, fixed points per trail, and trails expire by age rather than frame count.
import type { DrawList, RGB } from './draw.ts';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  size: number;
  c: RGB;
}

export class Particles {
  private items: Particle[] = [];
  private free: Particle[] = [];
  capacity: number;
  density = 1;
  enabled = true;
  gravity = -6;
  private seed = 1;

  constructor(capacity = 700) {
    this.capacity = capacity;
  }

  private rand(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  burst(x: number, y: number, c: RGB, strength: number, now: number, nx = 0, ny = 1): void {
    if (!this.enabled) return;
    const n = Math.min(14, Math.round((3 + strength * 9) * this.density));
    for (let i = 0; i < n; i++) {
      if (this.items.length >= this.capacity) this.free.push(this.items.shift()!);
      const p = this.free.pop() ?? { x: 0, y: 0, vx: 0, vy: 0, born: 0, life: 0, size: 0, c };
      const a = this.rand() * Math.PI * 2;
      const sp = (0.6 + this.rand() * 2.4) * (0.5 + strength);
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * sp + nx * sp * 0.8;
      p.vy = Math.sin(a) * sp + ny * sp * 0.8;
      p.born = now;
      p.life = 0.35 + this.rand() * 0.45;
      p.size = 0.05 + this.rand() * 0.07;
      p.c = c;
      this.items.push(p);
    }
  }

  draw(dl: DrawList, now: number, dt: number): void {
    const g = this.gravity;
    let w = 0;
    for (let i = 0; i < this.items.length; i++) {
      const p = this.items[i];
      const age = now - p.born;
      if (age > p.life || age < -0.5) {
        this.free.push(p);
        continue;
      }
      p.vy += g * dt;
      p.vx *= 1 - 1.5 * dt;
      p.vy *= 1 - 1.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = 1 - age / p.life;
      dl.spark(p.x, p.y, p.size * (0.6 + k), p.c, k * k);
      this.items[w++] = p;
    }
    this.items.length = w;
  }

  clear(): void {
    for (const p of this.items) this.free.push(p);
    this.items.length = 0;
  }

  get count(): number {
    return this.items.length;
  }
}

const TRAIL_POINTS = 48;

interface Trail {
  xs: Float32Array;
  ys: Float32Array;
  ts: Float32Array;
  head: number;
  n: number;
  c: RGB;
  r: number;
  last: number;
}

/** History-based trails for free physics (performance scenes sample their trajectories analytically instead). */
export class Trails {
  private map = new Map<number, Trail>();
  private pool: Trail[] = [];
  length = 0.45;
  enabled = true;
  maxTrails = 220;

  record(id: number, x: number, y: number, now: number, c: RGB, r: number): void {
    if (!this.enabled) return;
    let tr = this.map.get(id);
    if (!tr) {
      if (this.map.size >= this.maxTrails) return;
      tr = this.pool.pop() ?? { xs: new Float32Array(TRAIL_POINTS), ys: new Float32Array(TRAIL_POINTS), ts: new Float32Array(TRAIL_POINTS), head: 0, n: 0, c, r, last: 0 };
      tr.head = 0;
      tr.n = 0;
      this.map.set(id, tr);
    }
    tr.c = c;
    tr.r = r;
    tr.last = now;
    // skip near-duplicate samples
    if (tr.n > 0) {
      const i = (tr.head - 1 + TRAIL_POINTS) % TRAIL_POINTS;
      if (now - tr.ts[i] < 0.012) return;
    }
    tr.xs[tr.head] = x;
    tr.ys[tr.head] = y;
    tr.ts[tr.head] = now;
    tr.head = (tr.head + 1) % TRAIL_POINTS;
    tr.n = Math.min(TRAIL_POINTS, tr.n + 1);
  }

  draw(dl: DrawList, now: number): void {
    if (!this.enabled) return;
    for (const [id, tr] of this.map) {
      if (now - tr.last > this.length + 0.1) {
        this.map.delete(id);
        this.pool.push(tr);
        continue;
      }
      let px = NaN;
      let py = NaN;
      for (let k = tr.n - 1; k >= 0; k--) {
        const i = (tr.head - 1 - k + TRAIL_POINTS * 2) % TRAIL_POINTS;
        const age = now - tr.ts[i];
        const x = tr.xs[i];
        const y = tr.ys[i];
        if (age <= this.length && !Number.isNaN(px)) {
          const f = 1 - age / this.length;
          if ((x - px) ** 2 + (y - py) ** 2 < 9) dl.line(px, py, x, y, tr.r * 0.55 * f + 0.01, tr.c, f * f * 0.55, 0, 'trail');
        }
        px = x;
        py = y;
      }
    }
  }

  clear(): void {
    for (const tr of this.map.values()) this.pool.push(tr);
    this.map.clear();
  }
}

/** Draw a trail by sampling a deterministic position function backwards in time. */
export function drawSampledTrail(dl: DrawList, sample: (t: number) => { x: number; y: number; visible: boolean } | null, now: number, length: number, r: number, c: RGB, steps = 16): void {
  let prev: { x: number; y: number } | null = null;
  for (let i = steps; i >= 0; i--) {
    const t = now - (length * i) / steps;
    const s = sample(t);
    if (!s || !s.visible) {
      prev = null;
      continue;
    }
    if (prev) {
      const f = 1 - i / steps;
      if ((s.x - prev.x) ** 2 + (s.y - prev.y) ** 2 < 16) dl.line(prev.x, prev.y, s.x, s.y, r * 0.55 * f + 0.01, c, f * f * 0.55, 0, 'trail');
    }
    prev = { x: s.x, y: s.y };
  }
}
