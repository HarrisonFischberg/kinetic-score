// One AudioContext for the whole app, created only after a user gesture.
// Routing: voice → per-instrument bus → (dry + ambience send) → master → glue
// compressor → peak limiter → output gain → speakers, and a parallel tap
// (pre speaker-mute) → MediaStreamDestination for recordings.

import { INSTRUMENTS, buildVoice, type InstrumentId } from './instruments.ts';
import { midiToFreq } from '../music/score.ts';

export interface PlayOptions {
  vel: number;
  when?: number;
  dur?: number;
  pan?: number;
}

export interface VoiceHandle {
  readonly start: number;
  readonly end: number;
  readonly inst: InstrumentId;
  cancel(): void;
}

interface ActiveVoice extends VoiceHandle {
  stopped: boolean;
  out: GainNode;
  pan: StereoPannerNode;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
}

export type MechKind = 'tick' | 'thud' | 'clack' | 'whoosh';

export class AudioEngine {
  ctx: AudioContext | null = null;
  maxVoices = 40;
  private voices: ActiveVoice[] = [];
  private buses = new Map<InstrumentId, GainNode>();
  private busLevels = new Map<InstrumentId, number>();
  private master!: GainNode;
  private speakerGain!: GainNode;
  private reverbSend!: GainNode;
  private mechBus!: GainNode;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private noise: AudioBuffer | null = null;
  private masterLevel = 0.8;
  private muted = false;
  private ambience = true;
  private mechLevel = 0.35;
  /** extra input for engines that synthesise continuously (Shepard lab) */
  input!: GainNode;
  voicesStolen = 0;

  get running(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  get supported(): boolean {
    return typeof window !== 'undefined' && ('AudioContext' in window || 'webkitAudioContext' in window);
  }

  /** Must be called from a user gesture handler. */
  async start(): Promise<void> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.buildGraph(ctx);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async suspend(): Promise<void> {
    if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend();
  }

  now(): number {
    return this.ctx ? this.ctx.currentTime : performance.now() / 1000;
  }

  /** Output latency estimate, used to line visuals up with what is heard. */
  get outputLatency(): number {
    const c = this.ctx as (AudioContext & { outputLatency?: number }) | null;
    if (!c) return 0;
    return Math.min(0.25, (c.outputLatency || 0) + (c.baseLatency || 0));
  }

  private buildGraph(ctx: AudioContext): void {
    this.master = ctx.createGain();
    this.master.gain.value = this.masterLevel;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -20;
    glue.knee.value = 12;
    glue.ratio.value = 3.5;
    glue.attack.value = 0.008;
    glue.release.value = 0.22;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.08;
    const post = ctx.createGain();
    post.gain.value = 0.9;
    this.speakerGain = ctx.createGain();
    this.speakerGain.gain.value = this.muted ? 0 : 1;
    this.master.connect(glue).connect(limiter).connect(post);
    post.connect(this.speakerGain).connect(ctx.destination);
    if (typeof ctx.createMediaStreamDestination === 'function') {
      this.recordDest = ctx.createMediaStreamDestination();
      post.connect(this.recordDest);
    }
    // ambience: short synthetic room, kept subtle
    const conv = ctx.createConvolver();
    conv.buffer = this.makeImpulse(ctx, 2.2);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = this.ambience ? 0.22 : 0;
    this.reverbSend.connect(conv).connect(this.master);
    for (const inst of INSTRUMENTS) {
      const g = ctx.createGain();
      g.gain.value = this.busLevels.get(inst.id) ?? 0.8;
      g.connect(this.master);
      g.connect(this.reverbSend);
      this.buses.set(inst.id, g);
    }
    this.mechBus = ctx.createGain();
    this.mechBus.gain.value = this.mechLevel;
    this.mechBus.connect(this.master);
    this.input = ctx.createGain();
    this.input.connect(this.master);
    this.input.connect(this.reverbSend);
    const len = Math.floor(ctx.sampleRate * 0.25);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      d[i] = (seed / 4294967296) * 2 - 1;
    }
  }

  private makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    let seed = 987654;
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const t = i / len;
        data[i] = ((seed / 4294967296) * 2 - 1) * Math.pow(1 - t, 3.2) * (i < 64 ? i / 64 : 1);
      }
    }
    return buf;
  }

  play(inst: InstrumentId, midi: number, opts: PlayOptions): VoiceHandle | null {
    return this.playFreq(inst, midiToFreq(midi), opts);
  }

  playFreq(inst: InstrumentId, freq: number, opts: PlayOptions): VoiceHandle | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return null;
    const bus = this.buses.get(inst);
    if (!bus || !(freq > 20 && freq < 16000)) return null;
    const now = ctx.currentTime;
    const when = Math.max(now + 0.002, opts.when ?? now);
    this.reap(now);
    if (this.voices.length >= this.maxVoices) {
      // steal the voice that started earliest (already sounding the longest)
      let oldest = this.voices[0];
      for (const v of this.voices) if (v.start < oldest.start) oldest = v;
      oldest.cancel();
      this.voicesStolen++;
      this.reap(now);
    }
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, opts.pan ?? 0));
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(pan).connect(bus);
    const built = buildVoice(ctx, inst, out, freq, when, opts.vel, opts.dur ?? 0.3);
    const v: ActiveVoice = {
      start: when,
      end: built.end,
      inst,
      stopped: false,
      out,
      pan,
      sources: built.sources,
      nodes: built.nodes,
      cancel: () => this.cancelVoice(v),
    };
    this.voices.push(v);
    const first = built.sources[0];
    if (first) first.onended = () => this.dispose(v);
    return v;
  }

  private cancelVoice(v: ActiveVoice): void {
    if (v.stopped || !this.ctx) return;
    v.stopped = true;
    const now = this.ctx.currentTime;
    if (v.start > now + 0.005) {
      // not started yet: never let it sound
      for (const s of v.sources) {
        try {
          s.stop(0);
        } catch {
          /* already stopped */
        }
      }
      this.dispose(v);
      return;
    }
    v.out.gain.cancelScheduledValues(now);
    v.out.gain.setValueAtTime(v.out.gain.value, now);
    v.out.gain.linearRampToValueAtTime(0, now + 0.025);
    for (const s of v.sources) {
      try {
        s.stop(now + 0.04);
      } catch {
        /* ignore */
      }
    }
  }

  private dispose(v: ActiveVoice): void {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    v.stopped = true;
    for (const s of v.sources) s.disconnect();
    for (const n of v.nodes) n.disconnect();
    v.out.disconnect();
    v.pan.disconnect();
  }

  private reap(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.end < now - 0.1) this.dispose(v);
      else if (v.stopped && v.start > now) this.dispose(v);
    }
  }

  get activeVoices(): number {
    return this.voices.filter((v) => !v.stopped).length;
  }

  /** Cancel every voice scheduled to start after `time` (default: now). */
  cancelFuture(time?: number): number {
    if (!this.ctx) return 0;
    const t = time ?? this.ctx.currentTime;
    let n = 0;
    for (const v of [...this.voices]) {
      if (v.start > t) {
        v.cancel();
        n++;
      }
    }
    return n;
  }

  /** Fade out everything, sounding or scheduled. */
  stopAll(): void {
    for (const v of [...this.voices]) v.cancel();
  }

  mech(kind: MechKind, vel: number, pan = 0, when?: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.noise || this.mechLevel <= 0) return;
    const t = Math.max(ctx.currentTime, when ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    const a = Math.min(1, vel) * 0.18;
    let dur = 0.05;
    if (kind === 'tick') {
      bp.frequency.value = 3200;
      bp.Q.value = 3;
      dur = 0.03;
    } else if (kind === 'clack') {
      bp.frequency.value = 1500;
      bp.Q.value = 5;
      dur = 0.06;
    } else if (kind === 'thud') {
      bp.frequency.value = 180;
      bp.Q.value = 1.5;
      dur = 0.12;
    } else {
      bp.frequency.value = 800;
      bp.Q.value = 0.7;
      dur = 0.2;
    }
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(a, t + (kind === 'whoosh' ? 0.08 : 0.002));
    g.gain.exponentialRampToValueAtTime(a * 0.001, t + dur);
    src.connect(bp).connect(g).connect(p).connect(this.mechBus);
    src.start(t);
    src.stop(t + dur + 0.02);
    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      g.disconnect();
      p.disconnect();
    };
  }

  setMasterVolume(v: number): void {
    this.masterLevel = Math.max(0, Math.min(1, v));
    if (this.ctx) this.master.gain.setTargetAtTime(this.masterLevel, this.ctx.currentTime, 0.03);
  }

  get masterVolume(): number {
    return this.masterLevel;
  }

  /** Mutes the speakers only — recordings still capture the mix. */
  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.speakerGain.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setInstrumentVolume(id: InstrumentId, v: number): void {
    this.busLevels.set(id, v);
    const g = this.buses.get(id);
    if (g && this.ctx) g.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  instrumentVolume(id: InstrumentId): number {
    return this.busLevels.get(id) ?? 0.8;
  }

  setAmbience(on: boolean): void {
    this.ambience = on;
    if (this.ctx) this.reverbSend.gain.setTargetAtTime(on ? 0.22 : 0, this.ctx.currentTime, 0.05);
  }

  get ambienceOn(): boolean {
    return this.ambience;
  }

  setMechVolume(v: number): void {
    this.mechLevel = v;
    if (this.ctx) this.mechBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  get mechVolume(): number {
    return this.mechLevel;
  }

  /** Audio for recordings (a live stream of the final mix), or null if unsupported. */
  get recordingStream(): MediaStream | null {
    return this.recordDest?.stream ?? null;
  }
}
