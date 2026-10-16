// Shepard-tone generator.
// N octave-spaced sine-ish layers share one cyclic phase (1.0 = one octave).
// Each layer's position on the log-frequency axis is x = ((i + phase) mod N) / N,
// its frequency fMin·2^(x·N), and its amplitude a raised-cosine window over x,
// which is exactly zero where a layer wraps from the top back to the bottom.
// For N ≥ 2 equally spaced layers the window sum is the constant N/2, so the
// normalised mix level is independent of phase — no pumping and no wrap clicks.
//
// `phase` is the *unwrapped* phase (octaves travelled). Layer i sits at
// (i + phase) mod N octaves above fMin, so every layer glides continuously and
// only the one at the very top (amplitude exactly 0) ever jumps to the bottom.
// (Wrapping the phase to [0, 1) first would make every layer drop an octave at
// once each time the phase wrapped — an audible "zip".)

export interface ShepardLayer {
  x: number;
  freq: number;
  amp: number;
}

export function shepardLayers(phase: number, layers: number, fMin: number, out: ShepardLayer[] = []): ShepardLayer[] {
  out.length = layers;
  for (let i = 0; i < layers; i++) {
    const x = (((i + phase) % layers) + layers) % layers / layers;
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

/**
 * AudioWorklet that synthesises the Shepard tone sample by sample: per-sample
 * phase, per-layer window amplitude and oscillator phase, so nothing is stepped
 * at the animation frame rate and a layer only changes octave at the exact
 * sample where its amplitude is zero. The main thread sends the visual phase
 * (unwrapped) each frame plus a rate estimate; the worklet extrapolates between
 * messages and follows the target with a short glide (shortest path modulo one
 * octave, which sounds identical by construction).
 */
export const WORKLET_SOURCE = `
class ShepardProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cur = 0; this.target = 0; this.rate = 0; this.msgTime = 0; this.started = false;
    this.n = 7; this.fMin = 41.2; this.weights = [1];
    this.theta = new Float64Array(${MAX_LAYERS});
    this.port.onmessage = (e) => {
      const d = e.data;
      this.target = d.total; this.rate = d.rate; this.msgTime = d.time;
      if (d.n !== this.n) this.n = d.n;
      this.fMin = d.fMin;
      if (d.brightness !== this.brightness) {
        this.brightness = d.brightness;
        const w = [];
        for (let k = 1; k <= 8; k++) w.push(k === 1 ? 1 : Math.pow(d.brightness, k - 1) / k);
        const sum = w.reduce((a, b) => a + b, 0);
        this.weights = w.map((v) => v / sum);
      }
      if (!this.started) { this.cur = d.total; this.started = true; }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const ch = out[0];
    const sr = sampleRate;
    const glide = 1 - Math.exp(-1 / (0.025 * sr));
    const N = this.n, fMin = this.fMin, w = this.weights, K = w.length;
    const TAU = 2 * Math.PI;
    for (let s = 0; s < ch.length; s++) {
      const t = currentTime + s / sr;
      const ahead = Math.min(0.25, Math.max(0, t - this.msgTime));
      let diff = this.target + this.rate * ahead - this.cur;
      diff -= Math.round(diff);
      this.cur += diff * glide;
      let sum = 0;
      for (let i = 0; i < N; i++) {
        let pos = (i + this.cur) % N;
        if (pos < 0) pos += N;
        const f = fMin * Math.pow(2, pos);
        let th = this.theta[i] + TAU * f / sr;
        if (th > TAU) th -= TAU;
        this.theta[i] = th;
        const amp = 0.5 - 0.5 * Math.cos(TAU * pos / N);
        if (amp < 1e-7) continue;
        // harmonics by recurrence: sin(k·th) = 2cos(th)·sin((k−1)·th) − sin((k−2)·th); fade those near Nyquist
        const c2 = 2 * Math.cos(th);
        let s0 = 0, s1 = Math.sin(th), v = 0;
        for (let k = 1; k <= K; k++) {
          const hf = k * f;
          if (hf > 16000) break;
          const fade = hf < 10000 ? 1 : (16000 - hf) / 6000;
          v += w[k - 1] * fade * s1;
          const s2 = c2 * s1 - s0; s0 = s1; s1 = s2;
        }
        sum += amp * v;
      }
      ch[s] = sum * (2 / N);
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch);
    return true;
  }
}
registerProcessor('musical-marbles-shepard', ShepardProcessor);
`;

export class ShepardEngine {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private node: AudioWorkletNode | null = null;
  private lastTotal = 0;
  private lastTime = -1;
  private rateEst = 0;
  /** fallback (no AudioWorklet, e.g. plain-http LAN address): per-frame oscillator automation */
  private fallback = false;
  private oscs: OscillatorNode[] = [];
  private gains: GainNode[] = [];
  private waveBrightness = -1;
  private layerBuf: ShepardLayer[] = [];
  private prevX: number[] = [];
  private prevF: number[] = [];
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
    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
      ctx.audioWorklet
        .addModule(url)
        .then(() => {
          if (this.ctx !== ctx || !this.filter) return;
          this.node = new AudioWorkletNode(ctx, 'musical-marbles-shepard', { numberOfInputs: 0, outputChannelCount: [1] });
          this.node.connect(this.filter);
        })
        .catch(() => this.useFallback())
        .finally(() => URL.revokeObjectURL(url));
    } else {
      this.useFallback();
    }
  }

  /** which synthesis path is in use (for tests/diagnostics) */
  get backend(): 'worklet' | 'oscillators' | 'pending' {
    return this.node ? 'worklet' : this.fallback ? 'oscillators' : 'pending';
  }

  private useFallback(): void {
    const ctx = this.ctx;
    if (!ctx || !this.filter || this.fallback) return;
    this.fallback = true;
    for (let i = 0; i < MAX_LAYERS; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g).connect(this.filter);
      o.start();
      this.oscs.push(o);
      this.gains.push(g);
      this.prevX.push(-1);
      this.prevF.push(0);
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

  /** Called every animation frame while the lab is open. `total` is the unwrapped phase in octaves. */
  update(total: number, s: ShepardSettings, enabled: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.out || !this.filter) return;
    const now = ctx.currentTime;
    this.active = enabled;
    this.out.gain.setTargetAtTime(enabled ? s.level * 0.5 : 0, now, 0.08);
    this.filter.frequency.setTargetAtTime(1500 + s.brightness * 9000, now, 0.1);
    const n = Math.max(2, Math.min(MAX_LAYERS, Math.round(s.layers)));
    // measured phase velocity, so the worklet can extrapolate smoothly between frames
    const dt = now - this.lastTime;
    if (this.lastTime >= 0 && dt > 0.001) {
      const meas = (total - this.lastTotal) / dt;
      if (Math.abs(total - this.lastTotal) > 0.4 || !enabled) this.rateEst = 0;
      else this.rateEst += (Math.max(-2, Math.min(2, meas)) - this.rateEst) * 0.25;
    }
    if (dt > 0.001 || this.lastTime < 0) {
      this.lastTotal = total;
      this.lastTime = now;
    }
    if (this.node) {
      this.node.port.postMessage({ total, rate: this.rateEst, time: now, n, fMin: s.fMin, brightness: s.brightness });
      return;
    }
    if (!this.fallback) return;
    const t = now + 0.03;
    this.setWave(s.brightness);
    const layers = shepardLayers(total, n, s.fMin, this.layerBuf);
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
      f.cancelScheduledValues(now);
      g.cancelScheduledValues(now);
      if (wrapped || prev < 0) {
        // only the top layer wraps, at a window edge (amplitude ~0): jump frequency silently
        g.setValueAtTime(0, now);
        f.setValueAtTime(l.freq, now);
      } else {
        // ramp from the value we scheduled last frame (reading .value can lag the audio thread)
        f.setValueAtTime(this.prevF[i], now);
        f.exponentialRampToValueAtTime(l.freq, t);
        g.setValueAtTime(g.value, now);
      }
      g.linearRampToValueAtTime(l.amp, t);
      this.prevX[i] = l.x;
      this.prevF[i] = l.freq;
    }
  }

  silence(): void {
    if (!this.ctx || !this.out) return;
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    this.active = false;
  }
}
