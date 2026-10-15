// PLAYGROUND · Collision Cascade: impacts spawn new marbles. Wall impacts and
// ball–ball impacts are distinct (different spawn rules, registers and voices);
// cooldowns, generation limits, overlap-free spawning, a population cap, a
// note-rate cap and lifetime recycling keep it an evolving texture, not an explosion.
import { Rng } from '../../core/rng.ts';
import { TAU, clamp } from '../../core/math.ts';
import type { Ball, ContactEvent } from '../../simulation/physics.ts';
import type { DrawList, RGB } from '../../rendering/draw.ts';
import { hsl } from '../../core/math.ts';
import { pitchColor } from '../../rendering/palette.ts';
import { INSTRUMENTS, type InstrumentId } from '../../audio/instruments.ts';
import { degreeToMidi, rootOptions, scaleOptions } from '../../music/scales.ts';
import type { ParamDef, ParamValue, Scene, SceneServices } from '../types.ts';
import { PhysicsHost, ballVisual } from '../physicsScene.ts';

interface Meta {
  lastSpawn: number;
  life: number;
}

export class CascadeScene implements Scene {
  readonly info = {
    id: 'cascade',
    title: 'Collision Cascade',
    mode: 'playground' as const,
    blurb: 'One marble starts it; collisions spawn more. Wall hits sound low and spawn along the wall, ball–ball hits ring high and split. Limits keep the swarm musical.',
    motion: 'Sandbox · real contacts trigger notes and spawns',
  };
  values: Record<string, ParamValue> = {
    wallSpawn: 0.35,
    ballSpawn: 0.6,
    maxGen: 5,
    cap: 45,
    cooldown: 0.6,
    lifetime: 14,
    noteRate: 14,
    gravity: 4,
    wallVoice: 'pluck',
    ballVoice: 'glass',
    scale: 'minorPent',
    root: '4',
  };
  readonly params: ParamDef[] = [
    { key: 'wallSpawn', label: 'Wall-hit spawn chance', type: 'range', min: 0, max: 1, step: 0.05, applies: 'live', group: 'Spawning', hint: 'Wall impacts spawn a sibling sliding along the wall' },
    { key: 'ballSpawn', label: 'Ball-hit spawn chance', type: 'range', min: 0, max: 1, step: 0.05, applies: 'live', group: 'Spawning', hint: 'Ball–ball impacts split off a smaller, higher child' },
    { key: 'maxGen', label: 'Generation limit', type: 'range', min: 1, max: 8, step: 1, applies: 'live', group: 'Spawning' },
    { key: 'cooldown', label: 'Spawn cooldown per ball', type: 'range', min: 0.1, max: 3, step: 0.1, unit: 's', applies: 'live', group: 'Spawning' },
    { key: 'cap', label: 'Population cap', type: 'range', min: 5, max: 120, step: 1, applies: 'live', group: 'Limits', hint: 'Oldest marbles fade out above this' },
    { key: 'lifetime', label: 'Lifetime', type: 'range', min: 3, max: 40, step: 1, unit: 's', applies: 'live', group: 'Limits', hint: 'Marbles are recycled after this long' },
    { key: 'noteRate', label: 'Max notes per second', type: 'range', min: 2, max: 40, step: 1, applies: 'live', group: 'Limits', hint: 'Voice budget: extra impacts stay silent (still visible)' },
    { key: 'gravity', label: 'Gravity', type: 'range', min: 0, max: 15, step: 0.5, applies: 'live', group: 'Physics' },
    { key: 'wallVoice', label: 'Wall voice', type: 'select', applies: 'live', group: 'Sound', options: INSTRUMENTS.map((i) => ({ value: i.id, label: i.label })) },
    { key: 'ballVoice', label: 'Ball–ball voice', type: 'select', applies: 'live', group: 'Sound', options: INSTRUMENTS.map((i) => ({ value: i.id, label: i.label })) },
    { key: 'scale', label: 'Scale', type: 'select', applies: 'live', group: 'Sound', options: scaleOptions() },
    { key: 'root', label: 'Key', type: 'select', applies: 'live', group: 'Sound', options: rootOptions() },
  ];
  private host = new PhysicsHost();
  private svc!: SceneServices;
  private rng = new Rng(1);
  private meta = new Map<number, Meta>();
  private tokens = 0;
  private spawned = 0;
  private silenced = 0;
  private lastGlobalSpawn = -1;
  private wallFlash = [0, 0, 0, 0];
  private lastDraw = 0;
  private readonly W = 7;
  private readonly H = 9;

  init(svc: SceneServices): void {
    this.svc = svc;
    this.host.init(svc);
    this.host.onContact = (e) => this.contact(e);
    this.host.onStep = (dt) => this.stepLogic(dt);
  }

  reset(): void {
    this.host.reset();
    this.svc.trails.clear();
    this.svc.particles.clear();
    this.rng = new Rng(this.svc.seed());
    this.meta.clear();
    this.tokens = 4;
    this.spawned = 0;
    this.silenced = 0;
    this.lastGlobalSpawn = -1;
    const w = this.host.world;
    w.clearColliders();
    w.params.restitution = 0.96;
    w.params.friction = 0.02;
    w.params.damping = 0;
    w.params.maxSpeed = 22;
    w.params.ballCollisions = true;
    w.params.gravityY = -Number(this.values.gravity);
    const { W, H } = this;
    const walls: [number, number, number, number][] = [
      [-W, -H, W, -H],
      [W, -H, W, H],
      [W, H, -W, H],
      [-W, H, -W, -H],
    ];
    walls.forEach(([a, b, c, d], i) => w.addCollider({ type: 'segment', ax: a, ay: b, bx: c, by: d, thickness: 0.12 }, { restitution: 1, friction: 0.2, sound: 'musical', tag: `wall${i}`, userData: i }));
    w.addCollider({ type: 'circle', x: 0, y: -1.5, r: 1.1 }, { restitution: 1, kick: 1.5, sound: 'musical', tag: 'hub', userData: 4 });
    this.addBall(-3.5, 6.5, 0.42, 7.5, -3, 0);
    this.addBall(3.8, 2, 0.42, -6, 5, 0);
  }

  private addBall(x: number, y: number, r: number, vx: number, vy: number, gen: number): Ball {
    const b = this.host.world.addBall(x, y, r, vx, vy, (gen * 0.13 + this.rng.next() * 0.08) % 1, gen);
    const pal = this.svc.palette();
    ballVisual(b).color = hsl(pal.hue + (gen / 8 - 0.3) * Math.max(0.3, pal.hueSpread), pal.sat, 0.6 + gen * 0.03);
    this.meta.set(b.id, { lastSpawn: this.host.simTime, life: Number(this.values.lifetime) * (0.75 + this.rng.next() * 0.5) });
    this.spawned++;
    return b;
  }

  /** find a free spot near (x, y) by searching rings of candidates (bounded) */
  private freeSpot(x: number, y: number, r: number): { x: number; y: number } | null {
    const w = this.host.world;
    for (let ring = 0; ring < 5; ring++) {
      const rad = r * (2.2 + ring * 1.4);
      const start = this.rng.range(0, TAU);
      for (let k = 0; k < 8; k++) {
        const a = start + (k * TAU) / 8;
        const px = clamp(x + Math.cos(a) * rad, -this.W + r + 0.2, this.W - r - 0.2);
        const py = clamp(y + Math.sin(a) * rad, -this.H + r + 0.2, this.H - r - 0.2);
        if (w.isFree(px, py, r * 1.05)) return { x: px, y: py };
      }
    }
    return null;
  }

  private note(inst: InstrumentId, pitch: number, vel: number, x: number): boolean {
    if (this.tokens < 1) {
      this.silenced++;
      return false;
    }
    this.tokens -= 1;
    this.host.playNote(inst, pitch, vel, x, 0.5);
    return true;
  }

  private contact(e: ContactEvent): void {
    const b = e.ball;
    const pal = this.svc.palette();
    const now = this.host.simTime;
    const maxGen = Number(this.values.maxGen);
    const live = this.host.liveCount;
    const cap = Number(this.values.cap);
    const scale = String(this.values.scale);
    const root = Number(this.values.root);
    if (e.other) {
      // ball–ball: high register, pitch rises with generation
      if (e.speed < 0.8) return;
      const o = e.other;
      const gen = Math.max(b.generation, o.generation);
      const pitch = degreeToMidi(4 + gen * 2 + ((b.id + o.id) % 3), root, scale, 5);
      if (this.host.cooldownOk(`bb${Math.min(b.id, o.id)}:${Math.max(b.id, o.id)}`, 0.15)) {
        if (this.note(String(this.values.ballVoice) as InstrumentId, pitch, clamp(0.3 + e.speed / 18, 0.25, 0.9), e.x)) this.svc.particles.burst(e.x, e.y, pitchColor(pal, pitch), 0.5, now);
        ballVisual(b).flash = 1;
        ballVisual(o).flash = 1;
      }
      const m = this.meta.get(b.id);
      if (gen < maxGen && live < cap && m && now - m.lastSpawn > Number(this.values.cooldown) && now - this.lastGlobalSpawn > 0.08 && this.rng.chance(Number(this.values.ballSpawn))) {
        const r = Math.max(0.16, Math.min(b.r, o.r) * 0.82);
        const spot = this.freeSpot(e.x, e.y, r);
        if (spot) {
          // child flies off perpendicular to the impact normal
          const sp = clamp(e.speed, 3, 9);
          const dir = this.rng.chance(0.5) ? 1 : -1;
          this.addBall(spot.x, spot.y, r, -e.ny * sp * dir, e.nx * sp * dir, gen + 1);
          m.lastSpawn = now;
          this.lastGlobalSpawn = now;
        }
      }
      return;
    }
    const idx = e.collider?.userData as number;
    if (e.speed < 1.2) return;
    if (!this.host.cooldownOk(`w${b.id}`, 0.12)) return;
    // walls: low register, each wall a different degree; hub: a fifth
    const deg = idx === 4 ? 4 : [0, 2, 1, 3][idx] ?? 0;
    const pitch = degreeToMidi(deg - b.generation, root, scale, 3);
    if (this.note(String(this.values.wallVoice) as InstrumentId, pitch, clamp(0.3 + e.speed / 16, 0.25, 1), e.x)) this.svc.particles.burst(e.x, e.y, pitchColor(pal, pitch), 0.4, now, e.nx, e.ny);
    if (idx < 4) this.wallFlash[idx] = 1;
    ballVisual(b).flash = 1;
    const m = this.meta.get(b.id);
    if (b.generation < maxGen && live < cap && m && now - m.lastSpawn > Number(this.values.cooldown) * 1.5 && now - this.lastGlobalSpawn > 0.08 && this.rng.chance(Number(this.values.wallSpawn))) {
      const r = Math.max(0.16, b.r * 0.9);
      const spot = this.freeSpot(b.x, b.y, r);
      if (spot) {
        // sibling slides along the wall (tangent), away from the parent
        const sp = clamp(Math.hypot(b.vx, b.vy), 3, 8);
        this.addBall(spot.x, spot.y, r, -e.ny * sp, e.nx * sp, b.generation + 1);
        m.lastSpawn = now;
        this.lastGlobalSpawn = now;
      }
    }
  }

  private stepLogic(dt: number): void {
    this.tokens = Math.min(Number(this.values.noteRate) * 0.5 + 1, this.tokens + dt * Number(this.values.noteRate));
    for (let i = 0; i < 4; i++) this.wallFlash[i] = Math.max(0, this.wallFlash[i] - dt * 5);
    const now = this.host.simTime;
    for (const b of this.host.world.balls) {
      const m = this.meta.get(b.id);
      const v = ballVisual(b);
      if (m && b.age > m.life && v.fadeOut <= 0) v.fadeOut = 0.5;
    }
    this.host.enforceCap(Number(this.values.cap));
    // never let the room go silent: re-seed when everything has been recycled
    if (this.host.world.balls.length === 0 && now > 0.5) this.addBall(this.rng.range(-4, 4), 7, 0.42, this.rng.range(-5, 5), -2, 0);
    for (const id of [...this.meta.keys()]) if (!this.host.world.balls.some((b) => b.id === id)) this.meta.delete(id);
  }

  update(dt: number): void {
    this.host.advance(dt);
  }

  onParam(key: string): void {
    if (key === 'gravity') this.host.world.params.gravityY = -Number(this.values.gravity);
    if (key === 'cap') this.host.enforceCap(Number(this.values.cap));
  }

  randomize(rand: () => number): void {
    this.values.wallSpawn = Math.round(rand() * 6) / 10;
    this.values.ballSpawn = Math.round((0.3 + rand() * 0.6) * 10) / 10;
    this.values.maxGen = 3 + Math.floor(rand() * 4);
    this.values.gravity = Math.round(rand() * 8);
    this.values.scale = ['majorPent', 'minorPent', 'dorian', 'wholeTone', 'lydian'][Math.floor(rand() * 5)];
    this.values.root = String(Math.floor(rand() * 12));
  }

  bounds() {
    return { minX: -this.W - 0.4, minY: -this.H - 0.4, maxX: this.W + 0.4, maxY: this.H + 0.4 };
  }

  render(dl: DrawList): void {
    const pal = this.svc.palette();
    const now = this.host.simTime;
    const { W, H } = this;
    const walls: [number, number, number, number][] = [
      [-W, -H, W, -H],
      [W, -H, W, H],
      [W, H, -W, H],
      [-W, H, -W, -H],
    ];
    walls.forEach(([a, b, c, d], i) => {
      const f = this.wallFlash[i];
      const col: RGB = f > 0.01 ? [pal.track[0] + f * 0.3, pal.track[1] + f * 0.3, pal.track[2] + f * 0.3] : pal.track;
      dl.line(a, b, c, d, 0.1 + f * 0.05, col, 0.8, 0.12 + f * 0.35);
    });
    dl.disc(0, -1.5, 1.1, pal.structure, 0.25);
    dl.ring(0, -1.5, 1.05, 0.06, pal.accent, 0.9, 0.15);
    this.svc.trails.draw(dl, now);
    this.host.drawBalls(dl, now);
    this.svc.particles.draw(dl, now, clamp(now - this.lastDraw, 0, 0.05));
    this.lastDraw = now;
  }

  stats(): [string, string][] {
    let maxGen = 0;
    for (const b of this.host.world.balls) maxGen = Math.max(maxGen, b.generation);
    return [
      ['Balls', String(this.host.liveCount)],
      ['Spawned', String(this.spawned)],
      ['Notes', String(this.host.notesPlayed)],
      ['Gen', String(maxGen)],
      ['Muted hits', String(this.silenced)],
    ];
  }

  loopInfo(): string {
    return 'Deterministic scene reset: the same seed reproduces the same cascade. Population, generations and note rate are capped.';
  }

  dispose(): void {
    this.host.world.clearBalls();
  }
}
