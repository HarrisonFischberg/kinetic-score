// PLAYGROUND · Growing Ball: marbles bounce in an arena; every wall impact grows
// the ball, steps through a melodic sequence, shifts its register and timbre,
// and pulses the arena. A safe size limit ends each cycle with a closing chord
// and a gentle burst, then a new small ball is released.
import { Rng } from '../../core/rng.ts';
import { TAU, clamp } from '../../core/math.ts';
import type { ContactEvent } from '../../simulation/physics.ts';
import type { DrawList, RGB } from '../../rendering/draw.ts';
import { paletteHue, pitchColor } from '../../rendering/palette.ts';
import type { InstrumentId } from '../../audio/instruments.ts';
import { degreeToMidi, rootOptions, scaleOptions } from '../../music/scales.ts';
import { noteName } from '../../music/score.ts';
import type { ParamDef, ParamValue, Scene, SceneServices } from '../types.ts';
import { PhysicsHost, ballVisual } from '../physicsScene.ts';

const TIMBRES: Record<string, { label: string; small: InstrumentId; large: InstrumentId }> = {
  glassBell: { label: 'Glass → bell', small: 'glass', large: 'bell' },
  pluckVoice: { label: 'Pluck → voice', small: 'pluck', large: 'voice' },
  arcadeMarimba: { label: 'Arcade → marimba', small: 'arcade', large: 'marimba' },
};

const PATTERNS: Record<string, { label: string; steps: number[] }> = {
  rising: { label: 'Rising scale', steps: [0, 1, 2, 3, 4, 5, 6, 7] },
  arpeggio: { label: 'Arpeggio', steps: [0, 2, 4, 7, 4, 2] },
  falling: { label: 'Falling', steps: [7, 6, 5, 4, 3, 2, 1, 0] },
  call: { label: 'Call & answer', steps: [0, 4, 2, 5, 4, 1, 3, 0] },
};

interface GrowState {
  step: number;
  baseR: number;
  done: boolean;
  doneAt: number;
  lastPitch: number;
}

export class GrowingBallScene implements Scene {
  readonly info = {
    id: 'growing',
    title: 'Growing Ball',
    mode: 'playground' as const,
    blurb: 'Each impact makes the marble grow, steps its melody, lowers its register and morphs its timbre. At a safe size limit it resolves with a chord and starts again.',
    motion: 'Sandbox · real wall impacts trigger every note',
  };
  values: Record<string, ParamValue> = {
    arena: 'circle',
    balls: 1,
    growth: 0.045,
    speed: 10,
    gravity: 0,
    maxSize: 0.42,
    pattern: 'arpeggio',
    timbre: 'glassBell',
    scale: 'majorPent',
    root: '9',
  };
  readonly params: ParamDef[] = [
    { key: 'arena', label: 'Arena', type: 'select', applies: 'restart', options: [{ value: 'circle', label: 'Circle' }, { value: 'rect', label: 'Rectangle' }] },
    { key: 'balls', label: 'Balls', type: 'range', min: 1, max: 3, step: 1, applies: 'restart' },
    { key: 'growth', label: 'Growth per impact', type: 'range', min: 0, max: 0.12, step: 0.005, applies: 'live', hint: 'Fraction of the current radius added on each wall impact' },
    { key: 'maxSize', label: 'Size limit', type: 'range', min: 0.15, max: 0.5, step: 0.01, applies: 'live', hint: 'Fraction of the arena radius at which a cycle completes' },
    { key: 'speed', label: 'Speed', type: 'range', min: 2, max: 16, step: 0.5, applies: 'live' },
    { key: 'gravity', label: 'Gravity', type: 'range', min: 0, max: 15, step: 0.5, applies: 'live' },
    { key: 'pattern', label: 'Melody pattern', type: 'select', applies: 'live', options: Object.entries(PATTERNS).map(([value, p]) => ({ value, label: p.label })) },
    { key: 'timbre', label: 'Timbre morph', type: 'select', applies: 'live', options: Object.entries(TIMBRES).map(([value, p]) => ({ value, label: p.label })) },
    { key: 'scale', label: 'Scale', type: 'select', applies: 'live', options: scaleOptions() },
    { key: 'root', label: 'Key', type: 'select', applies: 'live', options: rootOptions() },
  ];
  private host = new PhysicsHost();
  private svc!: SceneServices;
  private rng = new Rng(1);
  private R = 6;
  private pulse = 0;
  private cycles = 0;
  private lastDraw = 0;
  private states = new Map<number, GrowState>();
  private respawnAt: number[] = [];

  init(svc: SceneServices): void {
    this.svc = svc;
    this.host.init(svc);
    this.host.onContact = (e) => this.contact(e);
    this.host.onStep = () => this.stepLogic();
  }

  reset(): void {
    this.host.reset();
    this.svc.trails.clear();
    this.svc.particles.clear();
    this.rng = new Rng(this.svc.seed());
    this.pulse = 0;
    this.cycles = 0;
    this.states.clear();
    this.respawnAt = [];
    const w = this.host.world;
    w.clearColliders();
    w.params.restitution = 1;
    w.params.friction = 0;
    w.params.damping = 0;
    w.params.ballCollisions = true;
    w.params.maxSpeed = 30;
    this.applyLive();
    if (this.values.arena === 'circle') {
      w.addCollider({ type: 'arc', x: 0, y: 0, radius: this.R, thickness: 0.12, start: 0, sweep: TAU }, { restitution: 1, friction: 0, sound: 'musical', tag: 'arena' });
    } else {
      const a = this.R;
      const b = this.R * 1.25;
      for (const [x1, y1, x2, y2] of [
        [-a, -b, a, -b],
        [a, -b, a, b],
        [a, b, -a, b],
        [-a, b, -a, -b],
      ])
        w.addCollider({ type: 'segment', ax: x1, ay: y1, bx: x2, by: y2, thickness: 0.12 }, { restitution: 1, friction: 0, sound: 'musical', tag: 'arena' });
    }
    const n = Number(this.values.balls);
    for (let i = 0; i < n; i++) this.spawn(i);
  }

  private applyLive(): void {
    this.host.world.params.gravityY = -Number(this.values.gravity);
  }

  private spawn(i: number): void {
    const r0 = 0.35;
    const a = this.rng.range(0, TAU);
    const off = (i - (Number(this.values.balls) - 1) / 2) * 2.2;
    const sp = Number(this.values.speed);
    let x = off;
    let y = 0.5;
    for (let k = 0; k < 10 && !this.host.world.isFree(x, y, r0 * 1.5); k++) y += 1;
    const b = this.host.world.addBall(x, y, r0, Math.cos(a) * sp, Math.sin(a) * sp, (i * 0.33 + this.rng.next() * 0.2) % 1);
    ballVisual(b).color = paletteHue(this.svc.palette(), b.hue);
    this.states.set(b.id, { step: 0, baseR: r0, done: false, doneAt: 0, lastPitch: 60 });
  }

  private sizeFrac(r: number): number {
    return clamp((r - 0.35) / (this.R * Number(this.values.maxSize) - 0.35), 0, 1);
  }

  private contact(e: ContactEvent): void {
    const b = e.ball;
    const st = this.states.get(b.id);
    if (!st || st.done) return;
    if (e.other) {
      if (e.speed > 1) this.host.mechanical(b, e.speed, e.x, 'clack');
      return;
    }
    if (!this.host.cooldownOk(b.id, 0.06)) return;
    const pal = this.svc.palette();
    const pat = PATTERNS[String(this.values.pattern)] ?? PATTERNS.arpeggio;
    const frac = this.sizeFrac(b.r);
    // register drops as the ball grows: up to −1 octave of scale degrees
    const scaleLen = String(this.values.scale).includes('Pent') ? 5 : 7;
    const degree = pat.steps[st.step % pat.steps.length] - Math.round(frac * scaleLen);
    const pitch = degreeToMidi(degree, Number(this.values.root), String(this.values.scale), 5);
    const tim = TIMBRES[String(this.values.timbre)] ?? TIMBRES.glassBell;
    const vel = clamp(0.45 + e.speed / 25, 0.3, 1);
    // timbre morph: crossfade two voices by size
    if (frac < 0.95) this.host.playNote(tim.small, pitch, vel * (1 - frac * 0.85), e.x, 0.5);
    if (frac > 0.05) this.host.playNote(tim.large, pitch, vel * (0.25 + frac * 0.75), e.x, 0.8);
    st.step++;
    st.lastPitch = pitch;
    ballVisual(b).flash = 1;
    this.pulse = 1;
    this.svc.particles.burst(e.x, e.y, pitchColor(pal, pitch), 0.6, this.host.simTime, e.nx, e.ny);
    // grow, but never past the limit
    const maxR = this.R * Number(this.values.maxSize);
    b.r = Math.min(maxR, b.r * (1 + Number(this.values.growth)));
    if (b.r >= maxR - 1e-6) this.complete(b.id);
    // keep the motion lively without letting energy run away
    const sp = Math.hypot(b.vx, b.vy);
    const target = Number(this.values.speed);
    if (sp > 0.01 && Number(this.values.gravity) === 0) {
      b.vx *= target / sp;
      b.vy *= target / sp;
    }
  }

  private complete(id: number): void {
    const st = this.states.get(id);
    const b = this.host.world.balls.find((x) => x.id === id);
    if (!st || !b) return;
    st.done = true;
    st.doneAt = this.host.simTime;
    const pal = this.svc.palette();
    const root = degreeToMidi(0, Number(this.values.root), String(this.values.scale), 3);
    const tim = TIMBRES[String(this.values.timbre)] ?? TIMBRES.glassBell;
    for (const [k, off] of [0, 7, 12, 16].entries()) this.svc.audio.play(k === 0 ? tim.large : tim.small, root + off, { vel: 0.55, dur: 2, pan: b.x / 10, when: this.svc.audio.now() + k * 0.06 });
    this.host.notesPlayed += 4;
    for (let i = 0; i < 4; i++) this.svc.particles.burst(b.x + Math.cos(i * 1.6) * b.r * 0.6, b.y + Math.sin(i * 1.6) * b.r * 0.6, pitchColor(pal, root + i * 4), 1, this.host.simTime);
    ballVisual(b).fadeOut = 0.6;
    this.cycles++;
    this.respawnAt.push(this.host.simTime + 1.4);
  }

  private stepLogic(): void {
    this.pulse = Math.max(0, this.pulse - 1 / 120 / 0.25);
    const now = this.host.simTime;
    // the size can also grow smoothly toward the target, so impacts read as "swelling"
    for (const b of this.host.world.balls) {
      const st = this.states.get(b.id);
      if (st?.done) {
        b.vx *= 0.97;
        b.vy *= 0.97;
      }
    }
    for (let i = this.respawnAt.length - 1; i >= 0; i--) {
      if (now >= this.respawnAt[i]) {
        this.respawnAt.splice(i, 1);
        this.spawn(this.host.world.balls.length % 3);
      }
    }
  }

  update(dt: number): void {
    this.host.advance(dt);
  }

  onParam(key: string): void {
    if (key === 'gravity') this.applyLive();
  }

  randomize(rand: () => number): void {
    const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
    this.values.pattern = pick(Object.keys(PATTERNS));
    this.values.timbre = pick(Object.keys(TIMBRES));
    this.values.scale = pick(['majorPent', 'minorPent', 'major', 'dorian', 'lydian']);
    this.values.root = String(Math.floor(rand() * 12));
    this.values.growth = Math.round((0.025 + rand() * 0.05) * 1000) / 1000;
    this.values.speed = Math.round(5 + rand() * 6);
  }

  bounds() {
    const b = this.values.arena === 'circle' ? this.R : this.R * 1.25;
    return { minX: -this.R - 0.4, minY: -b - 0.4, maxX: this.R + 0.4, maxY: b + 0.4 };
  }

  render(dl: DrawList): void {
    const pal = this.svc.palette();
    const now = this.host.simTime;
    const c: RGB = pal.track;
    const th = 0.08 + this.pulse * 0.05;
    if (this.values.arena === 'circle') {
      dl.ring(0, 0, this.R, th, c, 0.85, 0.15 + this.pulse * 0.3);
      if (this.pulse > 0.02) dl.ring(0, 0, this.R + 0.25 + (1 - this.pulse) * 0.6, 0.03, c, this.pulse * 0.5, 0, 'glow');
      // size-limit guide
      dl.ring(0, 0, this.R * Number(this.values.maxSize), 0.015, pal.dim, 0.25);
    } else {
      const a = this.R;
      const b = this.R * 1.25;
      dl.rect(0, 0, a, b, 0, c, 0.85, 0.3, th, 0.15 + this.pulse * 0.3);
    }
    this.svc.trails.draw(dl, now);
    this.host.drawBalls(dl, now);
    if (this.svc.appearance().noteLabels) {
      for (const b of this.host.world.balls) {
        const st = this.states.get(b.id);
        if (st && st.step > 0 && !st.done) dl.text(noteName(st.lastPitch), b.x, b.y, Math.max(0.22, b.r * 0.5), [0.05, 0.05, 0.1], 0.75, 'center');
      }
    }
    this.svc.particles.draw(dl, now, clamp(now - this.lastDraw, 0, 0.05));
    this.lastDraw = now;
  }

  stats(): [string, string][] {
    const b = this.host.world.balls[0];
    return [
      ['Notes', String(this.host.notesPlayed)],
      ['Cycles', String(this.cycles)],
      ['Size', b ? `${Math.round(this.sizeFrac(b.r) * 100)}%` : '–'],
    ];
  }

  loopInfo(): string {
    return 'Deterministic scene reset: Restart with the same seed replays the same bounce sequence. Cycles end at the size limit; it is not a seamless loop.';
  }

  dispose(): void {
    this.host.world.clearBalls();
  }
}
