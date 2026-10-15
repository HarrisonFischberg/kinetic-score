// 2D camera: overview (fit bounds), smooth follow with anticipation, manual pan/zoom.
import { clamp } from '../core/math.ts';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type CameraMode = 'overview' | 'follow' | 'manual';

export class CameraController {
  x = 0;
  y = 0;
  /** visible world height */
  height = 20;
  aspect = 1;
  mode: CameraMode = 'overview';
  bounds: Bounds = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
  private vx = 0;
  private vy = 0;
  private vh = 0;
  private targetX = 0;
  private targetY = 0;
  private targetH = 20;
  /** follow framing size requested by the scene */
  followHeight = 12;
  margin = 1.08;
  /** fraction of the view kept clear at the top (for the title overlay) */
  padTop = 0;

  setBounds(b: Bounds, snap = false): void {
    this.bounds = { ...b };
    if (snap) this.snapToOverview();
  }

  overviewTarget(): { x: number; y: number; h: number } {
    const b = this.bounds;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    const fit = Math.max(h, w / this.aspect) * this.margin;
    const total = fit / (1 - this.padTop);
    // shift the content down so the reserved band at the top stays clear
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 + (total - fit) / 2, h: total };
  }

  snapToOverview(): void {
    const o = this.overviewTarget();
    this.x = this.targetX = o.x;
    this.y = this.targetY = o.y;
    this.height = this.targetH = o.h;
    this.vx = this.vy = this.vh = 0;
  }

  /** when set, the next focus request jumps there instead of easing (scene start) */
  snapNext = false;

  /** Scene supplies a focus point each frame (used in follow mode). */
  setFocus(x: number, y: number, h?: number): void {
    if (this.mode !== 'follow') return;
    this.targetX = x;
    this.targetY = y;
    this.targetH = h ?? this.followHeight;
    if (this.snapNext) {
      this.snapNext = false;
      this.x = x;
      this.y = y;
      this.height = this.targetH;
      this.vx = this.vy = this.vh = 0;
    }
  }

  pan(dx: number, dy: number): void {
    this.mode = 'manual';
    this.x += dx;
    this.y += dy;
    this.targetX = this.x;
    this.targetY = this.y;
    this.targetH = this.height;
  }

  zoomAt(factor: number, wx: number, wy: number): void {
    this.mode = 'manual';
    const o = this.overviewTarget();
    const nh = clamp(this.height * factor, 1.5, o.h * 3);
    const k = nh / this.height;
    this.x = wx + (this.x - wx) * k;
    this.y = wy + (this.y - wy) * k;
    this.height = nh;
    this.targetX = this.x;
    this.targetY = this.y;
    this.targetH = nh;
  }

  setMode(m: CameraMode): void {
    this.mode = m;
    if (m === 'overview') {
      const o = this.overviewTarget();
      this.targetX = o.x;
      this.targetY = o.y;
      this.targetH = o.h;
    }
  }

  reset(): void {
    this.mode = 'overview';
    this.snapToOverview();
  }

  /** critically damped spring toward target — no abrupt cuts */
  update(dt: number, stiffness = 3.2): void {
    if (this.mode === 'overview') {
      const o = this.overviewTarget();
      this.targetX = o.x;
      this.targetY = o.y;
      this.targetH = o.h;
    }
    if (this.mode === 'manual') return;
    dt = Math.min(dt, 0.1);
    const w = stiffness;
    const step = (pos: number, vel: number, target: number): [number, number] => {
      const f = vel + (target - pos) * w * w * dt;
      const v = f / (1 + w * dt) ** 2;
      return [pos + v * dt, v];
    };
    [this.x, this.vx] = step(this.x, this.vx, this.targetX);
    [this.y, this.vy] = step(this.y, this.vy, this.targetY);
    [this.height, this.vh] = step(this.height, this.vh, this.targetH);
  }

  get width(): number {
    return this.height * this.aspect;
  }

  screenToWorld(sx: number, sy: number, w: number, h: number): { x: number; y: number } {
    return { x: this.x + (sx / w - 0.5) * this.width, y: this.y - (sy / h - 0.5) * this.height };
  }
}
