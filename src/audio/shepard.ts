// Shepard-tone generator.
// N octave-spaced sine-ish layers share one cyclic phase (1.0 = one octave).
// Each layer's position on the log-frequency axis is x = ((i + phase) mod N) / N,
// its frequency fMin·2^(x·N), and its amplitude a raised-cosine window over x,
// which is exactly zero where a layer wraps from the top back to the bottom.
// For N ≥ 2 equally spaced layers the window sum is the constant N/2, so the
// normalised mix level is independent of phase — no pumping and no wrap clicks.

export interface ShepardLayer {
  x: number;
  freq: number;
  amp: number;
}

export function shepardLayers(phase: number, layers: number, fMin: number, out: ShepardLayer[] = []): ShepardLayer[] {
  out.length = layers;
  const p = ((phase % 1) + 1) % 1;
  for (let i = 0; i < layers; i++) {
    const x = (((i + p) % layers) + layers) % layers / layers;
    const freq = fMin * Math.pow(2, x * layers);
    const amp = layers >= 2 ? (0.5 - 0.5 * Math.cos(2 * Math.PI * x)) * (2 / layers) : 1;
    const l = out[i] ?? { x: 0, freq: 0, amp: 0 };
    l.x = x;
    l.freq = freq;
    l.amp = amp;
    out[i] = l;
  }
  return out;
}

export interface ShepardSettings {
  direction: 1 | -1;
  /** semitones per second (continuous mode) */
  rate: number;
  layers: number;
  /** lowest frequency of the span (Hz) */
  fMin: number;
  /** 0..1: adds upper partials */
  brightness: number;
  level: number;
  mode: 'continuous' | 'stepped';
  /** semitones per collision step */
  stepSize: number;
}

export function defaultShepard(): ShepardSettings {
  return { direction: 1, rate: 0.9, layers: 7, fMin: 32.7, brightness: 0.35, level: 0.6, mode: 'continuous', stepSize: 1 };
}

/**
 * Phase state machine shared by the audio engine and the visuals. Stepped mode
 * glides toward a target phase with a short time constant so a step is a smooth
 * glissando rather than a jump.
 */
export class ShepardPhase {
  phase = 0;
  target = 0;
  /** unwrapped accumulated phase, for visuals that should keep turning */
  total = 0;

  advance(dt: number, s: ShepardSettings): void {
    let delta: number;
    if (s.mode === 'continuous') {
      delta = (s.direction * s.rate * dt) / 12;
      this.target += delta;
    } else {
      const k = 1 - Math.exp(-dt / 0.09);
      delta = (this.target - this.total) * k;
    }
    this.total += delta;
    this.phase = ((this.total % 1) + 1) % 1;
  }

  step(s: ShepardSettings, semis = s.stepSize): void {
    this.target += (s.direction * semis) / 12;
  }

  reset(): void {
    this.phase = 0;
    this.target = 0;
    this.total = 0;
  }
}

const MAX_LAYERS = 10;

export class ShepardEngine {
  private ctx: AudioContext | null = null;
  private oscs: OscillatorNode[] = [];
  private gains: GainNode[] = [];
  private out: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private waveBrightness = -1;
  private layerBuf: ShepardLayer[] = [];
  private prevX: number[] = [];
  active = false;

  attach(ctx: AudioContext, dest: AudioNode): void {
    if (this.ctx === ctx) return;
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 6000;
    this.filter.connect(this.out).connect(dest);
    for (let i = 0; i < MAX_LAYERS; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g).connect(this.filter);
      o.start();
      this.oscs.push(o);
      this.gains.push(g);
      this.prevX.push(-1);
    }
  }

  private setWave(brightness: number): void {
    if (!this.ctx || Math.abs(brightness - this.waveBrightness) < 0.02) return;
    this.waveBrightness = brightness;
    const n = 8;
    const real = new Float32Array(n + 1);
    const imag = new Float32Array(n + 1);
    for (let k = 1; k <= n; k++) imag[k] = k === 1 ? 1 : Math.pow(brightness, k - 1) * (1 / k);
    const wave = this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    for (const o of this.oscs) o.setPeriodicWave(wave);
  }

  /** Called every animation frame while the lab is open. */
  update(phase: number, s: ShepardSettings, enabled: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.out || !this.filter) return;
    const now = ctx.currentTime;
    const t = now + 0.03;
    this.active = enabled;
    this.out.gain.setTargetAtTime(enabled ? s.level * 0.5 : 0, now, 0.08);
    this.setWave(s.brightness);
    this.filter.frequency.setTargetAtTime(1500 + s.brightness * 9000, now, 0.1);
    const n = Math.max(2, Math.min(MAX_LAYERS, Math.round(s.layers)));
    const layers = shepardLayers(phase, n, s.fMin, this.layerBuf);
    for (let i = 0; i < MAX_LAYERS; i++) {
      const g = this.gains[i].gain;
      const f = this.oscs[i].frequency;
      if (i >= n) {
        g.setTargetAtTime(0, now, 0.05);
        this.prevX[i] = -1;
        continue;
      }
      const l = layers[i];
      const prev = this.prevX[i];
      const wrapped = prev >= 0 && Math.abs(l.x - prev) > 0.5;
      if (wrapped || prev < 0) {
        // the layer is at a window edge (amplitude ~0): jump frequency silently
        g.cancelScheduledValues(now);
        g.setValueAtTime(Math.min(g.value, 0.0005), now);
        f.cancelScheduledValues(now);
        f.setValueAtTime(l.freq, now + 0.004);
      } else {
        f.cancelScheduledValues(now);
        f.setValueAtTime(f.value, now);
        f.exponentialRampToValueAtTime(l.freq, t);
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
      }
      g.linearRampToValueAtTime(l.amp, t);
      this.prevX[i] = l.x;
    }
  }

  silence(): void {
    if (!this.ctx || !this.out) return;
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    this.active = false;
  }
}
