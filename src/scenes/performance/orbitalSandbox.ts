// SANDBOX variant of Orbital Classics: the same chime-lined arena, but free physics.
// Marbles bounce in zero gravity; every real contact with a chime plays that chime's
// pitch, and each impact grows the marble until a safe size limit, when it pops and a
// new one is released. This is an interpretive, generative rendition: it uses the
// song's pitches, not its rhythm.
import { TAU, clamp } from '../../core/math.ts';
import { Rng } from '../../core/rng.ts';
import type { ContactEvent } from '../../simulation/physics.ts';
import type { DrawList } from '../../rendering/draw.ts';
import { noteName, type ScoreData, type VoiceRole } from '../../music/score.ts';
import { groupNotes } from '../../choreography/mechanisms.ts';
import { timeNotes } from '../../music/score.ts';
import { PhysicsHost, ballVisual } from '../physicsScene.ts';
import type { SceneServices } from '../types.ts';
import type { Voicing } from './perfScene.ts';
import { R, HALVES, chimeAngles } from './orbital.ts';

interface Chime {
  pitch: number;
  angle: number;
  half: number;
  voice: VoiceRole;
  lastHit: number;
}

export class OrbitalSandbox {
  private host = new PhysicsHost();
  private chimes: Chime[] = [];
  private svc: SceneServices;
  private voicing: Voicing;
  private rng: Rng;
  private lastDraw = 0;
  private pops = 0;
  private readonly speed = 6.5;
  private readonly rMax = 1.05;

  constructor(score: ScoreData, voicing: Voicing, svc: SceneServices, seed: number) {
    this.svc = svc;
    this.voicing = voicing;
    this.rng = new Rng(seed);
    this.host.init(svc);
    this.host.onContact = (e) => this.contact(e);
    const w = this.host.world;
    w.params.gravityY = 0;
    w.params.restitution = 1;
    w.params.friction = 0;
    w.params.damping = 0;
    w.params.maxSpeed = 25;
    const notes = timeNotes(score, 1, 0);
    for (const h of HALVES) {
      const ps = [...new Set(groupNotes(notes.filter((n) => h.voices.includes(n.voice))).map((g) => g.top))].sort((a, b) => a - b);
      if (!ps.length) continue;
      const angles = chimeAngles(ps, h);
      const half = clamp((Math.abs(h.a1 - h.a0) / ps.length) * 0.48, 0.03, 0.2);
      const voice: VoiceRole = h.key === 'up' ? 'melody' : h.key === 'bass' ? 'bass' : 'counter';
      for (const p of ps) this.chimes.push({ pitch: p, angle: angles.get(p)!, half, voice, lastHit: -10 });
    }
    // chimes are real arc colliders; the rest of the rim and the equator are silent structure
    for (const c of this.chimes) w.addCollider({ type: 'arc', x: 0, y: 0, radius: R - 0.05, thickness: 0.06, start: c.angle - c.half, sweep: c.half * 2 }, { restitution: 1, friction: 0, sound: 'musical', userData: c });
    w.addCollider({ type: 'arc', x: 0, y: 0, radius: R + 0.02, thickness: 0.04, start: 0, sweep: TAU }, { restitution: 1, friction: 0, sound: 'silent' });
    w.addCollider({ type: 'segment', ax: -R * 0.86, ay: 0, bx: R * 0.86, by: 0, thickness: 0.06 }, { restitution: 1, friction: 0, sound: 'mechanical' });
    for (let i = 0; i < 3; i++) this.spawn(i);
  }

  private spawn(i: number): void {
    const above = i % 2 === 0;
    const x = this.rng.range(-3, 3);
    const y = (above ? 1 : -1) * this.rng.range(1.5, 4);
    const a = this.rng.range(0, TAU);
    if (!this.host.world.isFree(x, y, 0.3)) return;
    const b = this.host.world.addBall(x, y, 0.22, Math.cos(a) * this.speed, Math.sin(a) * this.speed, i / 3);
    ballVisual(b).color = this.svc.palette().voices[above ? 'melody' : 'bass'];
  }

  private contact(e: ContactEvent): void {
    const b = e.ball;
    // keep a lively, constant speed (zero-g arena, no energy drift)
    const sp = Math.hypot(b.vx, b.vy) || 1;
    b.vx *= this.speed / sp;
    b.vy *= this.speed / sp;
    if (e.other) return;
    const c = e.collider?.userData as Chime | null;
    if (!c) {
      if (e.collider?.sound === 'mechanical') this.host.mechanical(b, e.speed, e.x, 'tick');
      return;
    }
    if (!this.host.cooldownOk(c, 0.07)) return;
    c.lastHit = this.host.simTime;
    this.host.playNote(this.voicing[c.voice], c.pitch, clamp(0.45 + b.r * 0.4, 0.4, 0.95), e.x, 0.8);
    const v = ballVisual(b);
    v.flash = 1;
    v.color = this.svc.palette().voices[c.voice];
    this.svc.particles.burst(e.x, e.y, this.svc.palette().voices[c.voice], 0.5, this.host.simTime, e.nx, e.ny);
    // grow on impact; pop gracefully at the limit and release a fresh marble
    b.r = Math.min(this.rMax, b.r * 1.045);
    if (b.r >= this.rMax - 1e-6 && v.fadeOut <= 0) {
      v.fadeOut = 0.5;
      this.pops++;
      for (let k = 0; k < 4; k++) this.svc.particles.burst(b.x, b.y, v.color, 1, this.host.simTime);
      this.pendingSpawns.push(this.host.simTime + 0.8);
    }
  }

  private pendingSpawns: number[] = [];

  update(dt: number): void {
    this.host.advance(dt);
    for (let i = this.pendingSpawns.length - 1; i >= 0; i--) {
      if (this.host.simTime >= this.pendingSpawns[i]) {
        this.pendingSpawns.splice(i, 1);
        this.spawn(this.pops);
      }
    }
  }

  render(dl: DrawList): void {
    const pal = this.svc.palette();
    const app = this.svc.appearance();
    const now = this.host.simTime;
    dl.ring(0, 0, R + 0.05, 0.02, pal.structure, 0.6);
    dl.line(-R * 0.86, 0, R * 0.86, 0, 0.06, pal.structure, 0.85, 0.05);
    dl.line(0, -0.4, 0, -R * 0.7, 0.025, pal.grid, 0.8);
    for (const c of this.chimes) {
      const col = pal.voices[c.voice];
      const f = app.highlights ? Math.exp(-(now - c.lastHit) / 0.25) : 0;
      dl.arc(0, 0, R - 0.05, 0.05 + f * 0.03, c.angle - c.half, c.half * 2, col, 0.6 + f * 0.4, 0.08 + f * 0.35);
      if (f > 0.03) dl.glow(Math.cos(c.angle) * R, Math.sin(c.angle) * R, 1.1, col, f * 0.6);
      if (app.noteLabels) dl.text(noteName(c.pitch), Math.cos(c.angle) * (R + 0.45), Math.sin(c.angle) * (R + 0.45), 0.2, pal.text, 0.4 + f * 0.6, 'center');
    }
    // size-limit guide
    dl.ring(0, 0, 0.6, 0.01, pal.grid, 0.5);
    this.svc.trails.draw(dl, now);
    this.host.drawBalls(dl, now, (b) => ballVisual(b).color);
    this.svc.particles.draw(dl, now, clamp(now - this.lastDraw, 0, 0.05));
    this.lastDraw = now;
  }

  stats(): [string, string][] {
    return [
      ['Notes', String(this.host.notesPlayed)],
      ['Marbles', String(this.host.liveCount)],
      ['Pops', String(this.pops)],
    ];
  }

  dispose(): void {
    this.host.world.clearBalls();
  }
}
