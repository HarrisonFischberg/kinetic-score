// PLAYGROUND · Shepard-Tone Lab: a controllable Shepard illusion tied to the
// simulation. The ring of twelve steps around the arena *is* the pitch phase:
// in continuous mode it turns steadily (the geometry drives the tone); in
// collision-stepped mode every marble impact advances the phase by a step and
// the staircase turns with it. Layers are visualised as rings (pitch helix)
// and as a spectrum strip with the bell-shaped loudness window.
import { Rng } from '../../core/rng.ts';
import { TAU, clamp } from '../../core/math.ts';
import type { ContactEvent } from '../../simulation/physics.ts';
import type { DrawList } from '../../rendering/draw.ts';
import { hsl } from '../../core/math.ts';
import { defaultShepard, ShepardPhase, shepardLayers, type ShepardLayer, type ShepardSettings } from '../../audio/shepard.ts';
import type { ParamDef, ParamValue, Scene, SceneServices } from '../types.ts';
import { PhysicsHost, ballVisual } from '../physicsScene.ts';

const RANGES: Record<string, { label: string; fMin: number }> = {
  low: { label: 'Low (from 27.5 Hz)', fMin: 27.5 },
  mid: { label: 'Middle (from 41 Hz)', fMin: 41.2 },
  high: { label: 'High (from 65 Hz)', fMin: 65.4 },
};

export class ShepardLabScene implements Scene {
  readonly info = {
    id: 'shepard',
    title: 'Shepard-Tone Lab',
    mode: 'playground' as const,
    blurb: 'An endless staircase of sound: octave-spaced layers glide together under a bell-shaped loudness window, so the pitch seems to rise (or fall) forever.',
    motion: 'Sandbox · the turning staircase is the pitch phase; in stepped mode real impacts advance it',
  };
  values: Record<string, ParamValue> = {
    on: true,
    mode: 'continuous',
    direction: 'up',
    rate: 0.9,
    stepSize: 1,
    layers: 7,
    range: 'mid',
    brightness: 0.35,
    level: 0.6,
    balls: 3,
    pings: true,
  };
  readonly params: ParamDef[] = [
    { key: 'on', label: 'Shepard tone', type: 'toggle', applies: 'live', group: 'Illusion' },
    { key: 'demo', label: 'Load demo preset', type: 'button', applies: 'live', group: 'Illusion', hint: 'Continuous rising tone with seven layers' },
    { key: 'mode', label: 'Motion', type: 'select', applies: 'live', group: 'Illusion', options: [{ value: 'continuous', label: 'Continuous glide' }, { value: 'stepped', label: 'Collision-stepped' }] },
    { key: 'direction', label: 'Direction', type: 'select', applies: 'live', group: 'Illusion', options: [{ value: 'up', label: 'Rising' }, { value: 'down', label: 'Falling' }] },
    { key: 'rate', label: 'Glide rate', type: 'range', min: 0.1, max: 6, step: 0.05, unit: 'st/s', applies: 'live', group: 'Illusion', visible: (v) => v.mode === 'continuous' },
    { key: 'stepSize', label: 'Step per impact', type: 'range', min: 1, max: 3, step: 1, unit: 'st', applies: 'live', group: 'Illusion', visible: (v) => v.mode === 'stepped' },
    { key: 'layers', label: 'Layers (octaves)', type: 'range', min: 3, max: 10, step: 1, applies: 'live', group: 'Sound' },
    { key: 'range', label: 'Pitch range', type: 'select', applies: 'live', group: 'Sound', options: Object.entries(RANGES).map(([value, r]) => ({ value, label: r.label })) },
    { key: 'brightness', label: 'Brightness', type: 'range', min: 0, max: 1, step: 0.01, applies: 'live', group: 'Sound' },
    { key: 'level', label: 'Shepard level', type: 'range', min: 0, max: 1, step: 0.01, applies: 'live', group: 'Sound' },
    { key: 'pings', label: 'Impact pings', type: 'toggle', applies: 'live', group: 'Sound', hint: 'Soft glass pings tuned to the current step' },
    { key: 'balls', label: 'Marbles', type: 'range', min: 0, max: 6, step: 1, applies: 'restart', group: 'Simulation' },
  ];
  private host = new PhysicsHost();
  private svc!: SceneServices;
  private phase = new ShepardPhase();
  private settings: ShepardSettings = defaultShepard();
  private layerBuf: ShepardLayer[] = [];
  private playing = true;
  private rng = new Rng(1);
  private lastDraw = 0;
  private steps = 0;
  private stepFlash = 0;
  private readonly R = 6;

  init(svc: SceneServices): void {
    this.svc = svc;
    this.host.init(svc);
    this.host.onContact = (e) => this.contact(e);
    this.host.onStep = (dt) => {
      this.phase.advance(dt, this.settings);
      this.stepFlash = Math.max(0, this.stepFlash - dt * 3);
    };
    this.syncSettings();
  }

  private syncSettings(): void {
    const s = this.settings;
    s.mode = this.values.mode === 'stepped' ? 'stepped' : 'continuous';
    s.direction = this.values.direction === 'down' ? -1 : 1;
    s.rate = Number(this.values.rate);
    s.stepSize = Number(this.values.stepSize);
    s.layers = Number(this.values.layers);
    s.fMin = (RANGES[String(this.values.range)] ?? RANGES.mid).fMin;
    s.brightness = Number(this.values.brightness);
    s.level = Number(this.values.level);
  }

  reset(): void {
    this.host.reset();
    this.svc.trails.clear();
    this.svc.particles.clear();
    this.phase.reset();
    this.steps = 0;
    this.rng = new Rng(this.svc.seed());
    const w = this.host.world;
    w.clearColliders();
    w.params.gravityY = 0;
    w.params.restitution = 1;
    w.params.friction = 0;
    w.params.damping = 0;
    w.params.maxSpeed = 20;
    w.addCollider({ type: 'arc', x: 0, y: 0, radius: this.R, thickness: 0.1, start: 0, sweep: TAU }, { restitution: 1, friction: 0, sound: 'musical', tag: 'rim' });
    w.addCollider({ type: 'circle', x: 0, y: 0, r: 0.9 }, { restitution: 1, sound: 'musical', tag: 'core' });
    const n = Number(this.values.balls);
    for (let i = 0; i < n; i++) {
      const a = (i / Math.max(1, n)) * TAU + this.rng.range(0, 0.5);
      const r = 3 + this.rng.range(-0.8, 0.8);
      const sp = this.rng.range(3.5, 6);
      const va = a + Math.PI / 2 + this.rng.range(-0.6, 0.6);
      const b = w.addBall(Math.cos(a) * r, Math.sin(a) * r, 0.3, Math.cos(va) * sp, Math.sin(va) * sp, i / Math.max(1, n));
      ballVisual(b).color = hsl(this.svc.palette().hue + i * 0.08, 0.8, 0.65);
    }
  }

  private contact(e: ContactEvent): void {
    if (e.other || e.speed < 0.5) return;
    if (!this.host.cooldownOk(e.ball.id, 0.08)) return;
    ballVisual(e.ball).flash = 1;
    if (this.settings.mode === 'stepped') {
      this.phase.step(this.settings);
      this.steps++;
      this.stepFlash = 1;
    }
    if (this.values.pings === true) {
      // ping tuned to the current pitch class of the illusion
      const pc = (this.phase.phase * 12 + (this.settings.mode === 'stepped' ? 0 : 0)) % 12;
      const pitch = 72 + Math.round(pc);
      this.host.playNote('glass', pitch, clamp(0.2 + e.speed / 30, 0.15, 0.45), e.x, 0.6);
    }
    const pal = this.svc.palette();
    this.svc.particles.burst(e.x, e.y, hsl(pal.hue + this.phase.phase, 0.8, 0.65), 0.4, this.host.simTime, e.nx, e.ny);
  }

  update(dt: number): void {
    this.host.advance(dt);
  }

  setPlaying(p: boolean): void {
    this.playing = p;
  }

  onParam(key: string): void {
    if (key === 'demo') {
      Object.assign(this.values, { on: true, mode: 'continuous', direction: 'up', rate: 0.9, layers: 7, range: 'mid', brightness: 0.35, level: 0.6 });
      this.svc.refreshControls();
    }
    this.syncSettings();
    if (key === 'mode') this.svc.refreshControls();
  }

  randomize(rand: () => number): void {
    this.values.direction = rand() < 0.5 ? 'up' : 'down';
    this.values.rate = Math.round((0.4 + rand() * 2) * 20) / 20;
    this.values.layers = 5 + Math.floor(rand() * 4);
    this.values.brightness = Math.round(rand() * 70) / 100;
    this.syncSettings();
  }

  bounds() {
    return { minX: -this.R - 0.6, minY: -this.R - 0.6, maxX: this.R + 4.6, maxY: this.R + 0.6 };
  }

  render(dl: DrawList): void {
    const svc = this.svc;
    const pal = svc.palette();
    const now = this.host.simTime;
    const s = this.settings;
    const ph = this.phase.phase;
    // drive the audio engine from the same phase the visuals use
    svc.shepard.update(ph, s, this.values.on === true && this.playing && svc.audio.running);
    const layers = shepardLayers(ph, Math.max(2, Math.round(s.layers)), s.fMin, this.layerBuf);
    // pitch helix: one ring per layer, radius by log-frequency position, brightness by loudness
    for (const l of layers) {
      const r = 1.2 + l.x * (this.R - 1.6);
      const c = hsl(pal.hue + l.x * 0.5, 0.8, 0.6);
      dl.ring(0, 0, r, 0.025 + l.amp * s.layers * 0.03, c, clamp(l.amp * s.layers * 0.5, 0.05, 0.9), 0.05 + l.amp * 0.6, 'trail');
    }
    // endless staircase: 12 steps whose radius climbs around the circle; the whole ring turns with the phase
    const rot = -this.phase.total * TAU * (s.direction > 0 ? 1 : 1);
    for (let k = 0; k < 12; k++) {
      const a0 = rot + (k / 12) * TAU;
      const a1 = a0 + TAU / 12 - 0.04;
      const r = this.R - 0.05 + (k / 12) * 0.0;
      const height = k / 11;
      const c = hsl(pal.hue + height * 0.6, 0.85, 0.45 + height * 0.25);
      dl.arc(0, 0, r, 0.09 + height * 0.06, a0, a1 - a0, c, 0.95, 0.1 + this.stepFlash * 0.2);
      // riser line between steps
      dl.line(Math.cos(a1) * (r - 0.25), Math.sin(a1) * (r - 0.25), Math.cos(a1) * (r + 0.25), Math.sin(a1) * (r + 0.25), 0.02, pal.dim, 0.5);
    }
    // phase pointer: fixed marker at the top shows where the staircase is
    dl.line(0, this.R + 0.25, 0, this.R + 0.75, 0.05, pal.accent, 0.9, 0.12);
    dl.disc(0, 0, 0.9, pal.structure, 0.25);
    dl.ring(0, 0, 0.88, 0.05, pal.accent, 0.8, 0.12);
    dl.text(s.mode === 'stepped' ? `${this.steps}` : s.direction > 0 ? '↑' : '↓', 0, 0, 0.5, pal.text, 0.8, 'center');
    svc.trails.draw(dl, now);
    this.host.drawBalls(dl, now);
    svc.particles.draw(dl, now, clamp(now - this.lastDraw, 0, 0.05));
    this.lastDraw = now;
    // spectrum strip: log-frequency axis with the bell window and each layer's level
    const x0 = this.R + 1.6;
    const y0 = -this.R + 0.4;
    const H = this.R * 2 - 0.8;
    dl.line(x0, y0, x0, y0 + H, 0.02, pal.dim, 0.6);
    let prevX = x0;
    let prevY = y0;
    for (let i = 0; i <= 48; i++) {
      const xx = i / 48;
      const w = 0.5 - 0.5 * Math.cos(TAU * xx);
      const px = x0 + w * 2.2;
      const py = y0 + xx * H;
      if (i) dl.line(prevX, prevY, px, py, 0.015, pal.grid, 0.9);
      prevX = px;
      prevY = py;
    }
    for (const l of layers) {
      const py = y0 + l.x * H;
      const w = l.amp * (s.layers / 2);
      const c = hsl(pal.hue + l.x * 0.5, 0.85, 0.62);
      dl.line(x0, py, x0 + w * 2.2 + 0.02, py, 0.05, c, 0.9, 0.06);
      dl.disc(x0 + w * 2.2, py, 0.11, c, 1);
      if (svc.appearance().noteLabels && l.amp * s.layers > 0.6) dl.text(`${Math.round(l.freq)} Hz`, x0 + w * 2.2 + 0.25, py, 0.2, pal.dim, 0.8, 'left');
    }
    dl.text('log f', x0, y0 + H + 0.35, 0.22, pal.dim, 0.8, 'center');
  }

  stats(): [string, string][] {
    return [
      ['Phase', `${(this.phase.phase * 12).toFixed(1)} st`],
      ['Turns', (this.phase.total).toFixed(2)],
      ['Steps', String(this.steps)],
    ];
  }

  loopInfo(): string {
    return 'Continuous illusion — not a loop. The tone is synthesised live; whether it sounds endless depends on your ears and speakers (it has been tested programmatically for octave spacing, a seamless window and phase continuity, not auditioned in this build).';
  }

  dispose(): void {
    this.svc.shepard.silence();
    this.host.world.clearBalls();
  }
}
