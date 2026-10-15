// Shared plumbing for free-physics (sandbox) scenes: world stepping, ball
// rendering with trails and flashes, population caps with graceful recycling,
// and contact → sound helpers with per-element cooldowns.
import { World, type Ball, type ContactEvent, FIXED_DT } from '../simulation/physics.ts';
import { Stepper } from '../simulation/stepper.ts';
import type { DrawList, RGB } from '../rendering/draw.ts';
import type { SceneServices } from './types.ts';
import type { InstrumentId } from '../audio/instruments.ts';
import { paletteHue } from '../rendering/palette.ts';

export interface BallVisual {
  flash: number;
  fadeOut: number; // >0 while being recycled: seconds remaining
  color: RGB;
}

export function ballVisual(b: Ball): BallVisual {
  if (!b.userData) b.userData = { flash: 0, fadeOut: 0, color: [1, 1, 1] } satisfies BallVisual;
  return b.userData as BallVisual;
}

export class PhysicsHost {
  world = new World();
  stepper = new Stepper(FIXED_DT, 12);
  svc!: SceneServices;
  /** fired for each contact entry after a fixed step */
  onContact: (e: ContactEvent) => void = () => {};
  onStep: (dt: number) => void = () => {};
  simTime = 0;
  private lastMech = new Map<number, number>();
  private elementCooldowns = new Map<unknown, number>();
  notesPlayed = 0;

  init(svc: SceneServices): void {
    this.svc = svc;
  }

  advance(dt: number): void {
    const n = this.stepper.advance(dt);
    for (let i = 0; i < n; i++) this.stepOnce();
  }

  stepOnce(): void {
    this.onStep(FIXED_DT);
    this.world.step(FIXED_DT);
    this.simTime += FIXED_DT;
    const evs = this.world.events;
    for (let i = 0; i < evs.length; i++) this.onContact(evs[i]);
    evs.length = 0;
    // recycle fade
    for (let i = this.world.balls.length - 1; i >= 0; i--) {
      const b = this.world.balls[i];
      const v = ballVisual(b);
      v.flash = Math.max(0, v.flash - FIXED_DT * 4);
      if (v.fadeOut > 0) {
        v.fadeOut -= FIXED_DT;
        if (v.fadeOut <= 0) this.world.removeBall(b);
      }
    }
  }

  /** Keep the population under `cap` by fading out the oldest balls. */
  enforceCap(cap: number): void {
    const alive = this.world.balls.filter((b) => ballVisual(b).fadeOut <= 0);
    let excess = alive.length - cap;
    if (excess <= 0) return;
    alive.sort((a, b) => b.age - a.age);
    for (const b of alive) {
      if (excess-- <= 0) break;
      ballVisual(b).fadeOut = 0.35;
    }
  }

  get liveCount(): number {
    let n = 0;
    for (const b of this.world.balls) if (ballVisual(b).fadeOut <= 0) n++;
    return n;
  }

  /** Throttle per key (element) — returns true if allowed now. */
  cooldownOk(key: unknown, seconds: number): boolean {
    const last = this.elementCooldowns.get(key);
    if (last !== undefined && this.simTime - last < seconds) return false;
    this.elementCooldowns.set(key, this.simTime);
    return true;
  }

  playNote(inst: InstrumentId, pitch: number, vel: number, x: number, dur = 0.4): void {
    const pan = Math.max(-0.8, Math.min(0.8, x / 10));
    this.svc.audio.play(inst, pitch, { vel, pan, dur });
    this.notesPlayed++;
  }

  mechanical(b: Ball, speed: number, x: number, kind: 'tick' | 'clack' | 'thud' = 'tick'): void {
    if (speed < 2.2) return;
    const last = this.lastMech.get(b.id) ?? -1;
    if (this.simTime - last < 0.12) return;
    this.lastMech.set(b.id, this.simTime);
    this.svc.audio.mech(kind, Math.min(1, speed / 14), x / 10);
  }

  drawBalls(dl: DrawList, now: number, colorOf?: (b: Ball) => RGB): void {
    const svc = this.svc;
    const pal = svc.palette();
    for (const b of this.world.balls) {
      const v = ballVisual(b);
      const c = colorOf ? colorOf(b) : (v.color ?? paletteHue(pal, b.hue));
      const alpha = v.fadeOut > 0 ? Math.max(0, v.fadeOut / 0.35) : 1;
      svc.trails.record(b.id, b.x, b.y, now, c, b.r);
      dl.ball(b.x, b.y, b.r, c, alpha, b.spin, v.flash);
    }
  }

  reset(): void {
    this.world.clearBalls();
    this.world.resetCounters();
    this.stepper.reset();
    this.simTime = 0;
    this.lastMech.clear();
    this.elementCooldowns.clear();
    this.notesPlayed = 0;
  }
}
