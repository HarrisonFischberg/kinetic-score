// Synthesised voices. Each builder wires oscillators/filters for one note into
// `out` and returns the nodes to stop plus the time the note is fully silent.

export type InstrumentId = 'bell' | 'glass' | 'marimba' | 'pluck' | 'arcade' | 'voice';

export const INSTRUMENTS: { id: InstrumentId; label: string; hint: string }[] = [
  { id: 'bell', label: 'Bell', hint: 'Bright struck bell with inharmonic partials and a long ring' },
  { id: 'glass', label: 'Glass chime', hint: 'Pure glassy chime, soft attack, shimmering decay' },
  { id: 'marimba', label: 'Marimba pluck', hint: 'Wooden mallet tone, short and round' },
  { id: 'pluck', label: 'Warm pluck', hint: 'Warm filtered pluck, guitar-like' },
  { id: 'arcade', label: 'Arcade tone', hint: 'Soft square-wave blip' },
  { id: 'voice', label: 'Sustained voice', hint: 'Breathy sustained pad that holds for the note length' },
];

export function isInstrument(x: unknown): x is InstrumentId {
  return typeof x === 'string' && INSTRUMENTS.some((i) => i.id === x);
}

export interface BuiltVoice {
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  end: number;
}

interface Partial {
  ratio: number;
  amp: number;
  decay: number;
  type?: OscillatorType;
}

function partials(ctx: BaseAudioContext, out: AudioNode, freq: number, when: number, peak: number, attack: number, list: Partial[]): BuiltVoice {
  const sources: AudioScheduledSourceNode[] = [];
  const nodes: AudioNode[] = [];
  let end = when;
  const nyquist = ctx.sampleRate * 0.45;
  for (const p of list) {
    const f = freq * p.ratio;
    if (f > nyquist) continue;
    const osc = ctx.createOscillator();
    osc.type = p.type ?? 'sine';
    osc.frequency.value = f;
    const g = ctx.createGain();
    const a = peak * p.amp;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(a, when + attack);
    g.gain.exponentialRampToValueAtTime(Math.max(1e-5, a * 0.0005), when + attack + p.decay);
    osc.connect(g).connect(out);
    const stop = when + attack + p.decay + 0.02;
    osc.start(when);
    osc.stop(stop);
    end = Math.max(end, stop);
    sources.push(osc);
    nodes.push(g);
  }
  return { sources, nodes, end };
}

export function buildVoice(ctx: BaseAudioContext, inst: InstrumentId, out: AudioNode, freq: number, when: number, vel: number, dur: number): BuiltVoice {
  // keep high notes from piercing: gentle tilt above ~1.2 kHz
  const tilt = freq > 1200 ? Math.pow(1200 / freq, 0.35) : 1;
  const peak = Math.pow(Math.max(0.02, Math.min(1, vel)), 1.3) * 0.3 * tilt;
  const lowBoost = freq < 160 ? 1.35 : 1;
  switch (inst) {
    case 'bell':
      return partials(ctx, out, freq, when, peak * 0.85 * lowBoost, 0.002, [
        { ratio: 1, amp: 1, decay: 2.6 },
        { ratio: 2.0, amp: 0.42, decay: 1.7 },
        { ratio: 2.76, amp: 0.25, decay: 1.1 },
        { ratio: 4.07, amp: 0.16, decay: 0.7 },
        { ratio: 5.43, amp: 0.1, decay: 0.45 },
      ]);
    case 'glass':
      return partials(ctx, out, freq, when, peak * 0.9 * lowBoost, 0.006, [
        { ratio: 1, amp: 1, decay: 3.2 },
        { ratio: 2.76, amp: 0.2, decay: 1.4 },
        { ratio: 5.4, amp: 0.08, decay: 0.7 },
      ]);
    case 'marimba':
      return partials(ctx, out, freq, when, peak * 1.1 * lowBoost, 0.003, [
        { ratio: 1, amp: 1, decay: 0.75 },
        { ratio: 3.93, amp: 0.3, decay: 0.12 },
        { ratio: 9.2, amp: 0.06, decay: 0.04 },
      ]);
    case 'pluck': {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = freq;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 2;
      lp.frequency.setValueAtTime(Math.min(16000, freq * 8), when);
      lp.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 1.4), when + 0.35);
      const g = ctx.createGain();
      const a = peak * 1.2 * lowBoost;
      const decay = 1.1;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(a, when + 0.004);
      g.gain.exponentialRampToValueAtTime(a * 0.0005, when + decay);
      osc.connect(lp);
      sub.connect(lp);
      lp.connect(g).connect(out);
      const stop = when + decay + 0.03;
      osc.start(when);
      sub.start(when);
      osc.stop(stop);
      sub.stop(stop);
      return { sources: [osc, sub], nodes: [lp, g], end: stop };
    }
    case 'arcade': {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq * 1.02, when);
      osc.frequency.exponentialRampToValueAtTime(freq, when + 0.04);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(9000, freq * 5);
      const g = ctx.createGain();
      const a = peak * 0.5;
      const decay = Math.min(0.45, 0.16 + dur * 0.5);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(a, when + 0.004);
      g.gain.setValueAtTime(a, when + decay * 0.4);
      g.gain.exponentialRampToValueAtTime(a * 0.001, when + decay);
      osc.connect(lp).connect(g).connect(out);
      const stop = when + decay + 0.02;
      osc.start(when);
      osc.stop(stop);
      return { sources: [osc], nodes: [lp, g], end: stop };
    }
    case 'voice': {
      const hold = Math.max(0.15, Math.min(6, dur));
      const a = peak * 0.55 * lowBoost;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(5000, 700 + freq * 2);
      lp.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(a, when + 0.07);
      g.gain.setTargetAtTime(a * 0.7, when + 0.07, 0.3);
      g.gain.setTargetAtTime(0, when + hold, 0.12);
      const stop = when + hold + 0.7;
      const sources: AudioScheduledSourceNode[] = [];
      const vib = ctx.createOscillator();
      vib.frequency.value = 5.2;
      const vibGain = ctx.createGain();
      vibGain.gain.value = freq * 0.004;
      vib.connect(vibGain);
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = freq;
        o.detune.value = det;
        vibGain.connect(o.frequency);
        o.connect(lp);
        o.start(when);
        o.stop(stop);
        sources.push(o);
      }
      vib.start(when);
      vib.stop(stop);
      sources.push(vib);
      lp.connect(g).connect(out);
      return { sources, nodes: [lp, g, vibGain], end: stop };
    }
  }
}
