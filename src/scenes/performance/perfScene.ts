// Generic PERFORMANCE scene: a "family" builds a choreography (balls, props,
// activations) from a timed score; this class handles song/tempo/voicing
// parameters, rendering at transport time, deterministic sparks, camera
// follow, and turns activations into scheduled audio events.
import { TAU, clamp, lastIndexAtOrBefore } from '../../core/math.ts';
import { Rng } from '../../core/rng.ts';
import type { InstrumentId } from '../../audio/instruments.ts';
import { ActivationIndex, hash01, sampleActor, type Activation, type BallActor, type DrawCtx, type Sample } from '../../choreography/core.ts';
import { allScores, getScore, UNAVAILABLE } from '../../music/library.ts';
import { beatToSeconds, timeNotes, type ScoreData, type TimedNote, type VoiceRole } from '../../music/score.ts';
import type { Bounds } from '../../rendering/camera.ts';
import type { DrawList, RGB } from '../../rendering/draw.ts';
import type { Palette } from '../../rendering/palette.ts';
import { drawSampledTrail } from '../../rendering/effects.ts';
import type { ParamDef, ParamOption, ParamValue, PerfEvent, PerformanceInfo, Scene, SceneServices } from '../types.ts';

export type Voicing = Record<VoiceRole, InstrumentId>;

export const VOICINGS: Record<string, { label: string; v: Voicing }> = {
  classic: { label: 'Bells & mallets', v: { melody: 'bell', counter: 'glass', accomp: 'marimba', bass: 'pluck' } },
  mallets: { label: 'Mallet ensemble', v: { melody: 'marimba', counter: 'marimba', accomp: 'pluck', bass: 'marimba' } },
  glass: { label: 'Glass harmonica', v: { melody: 'glass', counter: 'glass', accomp: 'bell', bass: 'voice' } },
  warm: { label: 'Warm strings', v: { melody: 'voice', counter: 'pluck', accomp: 'pluck', bass: 'voice' } },
  arcade: { label: 'Arcade', v: { melody: 'arcade', counter: 'arcade', accomp: 'pluck', bass: 'marimba' } },
};

export interface PropCtx extends DrawCtx {
  pal: Palette;
  voiceColor(v: VoiceRole): RGB;
}

export interface Prop {
  id: string;
  /** back props draw before balls, front props after */
  layer?: 'back' | 'front';
  draw(dl: DrawList, t: number, ctx: PropCtx): void;
}

export interface Choreography {
  balls: BallActor[];
  props: Prop[];
  acts: Activation[];
  duration: number;
  bounds: Bounds;
  /** camera follow target (anticipatory) */
  focus?(t: number): { x: number; y: number; h: number };
  /** maximum plausible ball speed, for validation */
  maxSpeed: number;
  /** allowed distance between a ball and its activation point beyond its radius */
  contactTol: number;
}

export interface FamilyContext {
  voicing: Voicing;
  rng: Rng;
  leadIn: number;
  score: ScoreData;
  tempo: number;
}

export interface Family {
  id: string;
  title: string;
  blurb: string;
  motion: string;
  defaultSong: string;
  defaultVoicing: string;
  leadIn: number;
  /** reason this song cannot be performed here, or null */
  supports(score: ScoreData): string | null;
  build(notes: TimedNote[], ctx: FamilyContext): Choreography;
}

const LONG_TAIL = 2.5;

export class PerformanceScene implements Scene {
  readonly info: Scene['info'];
  readonly params: ParamDef[];
  values: Record<string, ParamValue>;
  private svc!: SceneServices;
  private family: Family;
  private choreo: Choreography | null = null;
  private index: ActivationIndex | null = null;
  private actTimes: number[] = [];
  private events: PerfEvent[] = [];
  private score: ScoreData | null = null;
  private phrases: { t: number; label: string }[] = [];
  private sortedBalls: BallActor[] = [];
  private ballStarts: number[] = [];
  private maxBallSpan = 0;
  private sample: Sample = { x: 0, y: 0, visible: false, alpha: 1, scale: 1 };
  /** problems reported by the last validation */
  validation: string[] = [];

  constructor(family: Family) {
    this.family = family;
    this.info = { id: family.id, title: family.title, mode: 'performance', blurb: family.blurb, motion: family.motion };
    this.values = { song: family.defaultSong, tempo: 1, voicing: family.defaultVoicing, guides: true };
    const songOpts: ParamOption[] = allScores().map((s) => {
      const reason = family.supports(s);
      return { value: s.id, label: `${s.title} — ${s.composer.split(' ').slice(-1)[0]}${s.priority ? '' : ''}`, disabled: reason ?? undefined };
    });
    for (const u of UNAVAILABLE) songOpts.push({ value: `unavailable:${u.title}`, label: u.title.split('—')[1]?.trim().split(',')[0] ?? u.title, disabled: 'no verified public-domain source bundled' });
    this.params = [
      { key: 'song', label: 'Song', type: 'select', applies: 'restart', options: songOpts, group: 'Performance' },
      { key: 'tempo', label: 'Tempo', type: 'range', min: 0.6, max: 1.4, step: 0.05, unit: '×', applies: 'restart', group: 'Performance', hint: 'Rebuilds the machine timing; pitch is unchanged. Applies on restart (R).' },
      { key: 'voicing', label: 'Instruments', type: 'select', applies: 'restart', group: 'Performance', options: Object.entries(VOICINGS).map(([value, v]) => ({ value, label: v.label })) },
      { key: 'guides', label: 'Show guide paths', type: 'toggle', applies: 'live', group: 'View', hint: 'Faint lines showing upcoming routes' },
    ];
  }

  init(svc: SceneServices): void {
    this.svc = svc;
  }

  reset(): void {
    this.build();
  }

  private build(): void {
    let score = getScore(String(this.values.song));
    if (!score || this.family.supports(score)) {
      score = getScore(this.family.defaultSong) ?? allScores()[0];
      if (score) this.values.song = score.id;
    }
    this.score = score ?? null;
    if (!score) {
      this.choreo = null;
      this.events = [];
      return;
    }
    const tempo = Number(this.values.tempo) || 1;
    const leadIn = this.family.leadIn;
    const notes = timeNotes(score, tempo, leadIn);
    const voicing = (VOICINGS[String(this.values.voicing)] ?? VOICINGS.classic).v;
    const ch = this.family.build(notes, { voicing, rng: new Rng(this.svc.seed() ^ 0x5bd1e995), leadIn, score, tempo });
    this.choreo = ch;
    ch.acts.sort((a, b) => a.time - b.time);
    this.actTimes = ch.acts.map((a) => a.time);
    this.index = new ActivationIndex(ch.acts);
    this.events = ch.acts.map((a) => ({ time: a.time, notes: a.notes, pan: clamp(a.x / Math.max(4, (ch.bounds.maxX - ch.bounds.minX) / 2), -0.85, 0.85), target: a.target }));
    this.sortedBalls = [...ch.balls].sort((a, b) => a.segs[0].t0 - b.segs[0].t0);
    this.ballStarts = this.sortedBalls.map((b) => b.segs[0].t0);
    this.maxBallSpan = this.sortedBalls.reduce((m, b) => Math.max(m, b.segs[b.segs.length - 1].t1 - b.segs[0].t0), 0);
    this.phrases = score.phrases.map((p) => ({ t: leadIn + beatToSeconds(p.t, score, tempo), label: p.label }));
    this.svc.camera.setBounds(ch.bounds, this.svc.camera.mode === 'overview');
  }

  /** for tests and diagnostics */
  getChoreography(): Choreography | null {
    return this.choreo;
  }

  update(): void {}

  onParam(key: string): void {
    if (key === 'song') this.build();
  }

  bounds(): Bounds {
    return this.choreo?.bounds ?? { minX: -10, minY: -10, maxX: 10, maxY: 10 };
  }

  performance(): PerformanceInfo | null {
    if (!this.choreo || !this.score) return null;
    const last = this.events.length ? this.events[this.events.length - 1].time : 0;
    const tail = Math.max(LONG_TAIL, ...this.events.slice(-8).flatMap((e) => e.notes.map((n) => n.dur)));
    return {
      songId: this.score.id,
      duration: Math.max(this.choreo.duration, last + Math.min(4, tail)),
      events: this.events,
      phraseAt: (t) => {
        const i = lastIndexAtOrBefore(this.phrases.map((p) => p.t), t);
        return i >= 0 ? this.phrases[i].label : '';
      },
    };
  }

  private ctx(): PropCtx {
    const pal = this.svc.palette();
    const app = this.svc.appearance();
    const idx = this.index!;
    return {
      pal,
      labels: app.noteLabels,
      highlights: app.highlights,
      voiceColor: (v) => pal.voices[v],
      flash: (target, t, decay = 0.18) => {
        if (!app.highlights) return 0;
        const s = idx.since(target, t);
        return s === Infinity ? 0 : Math.exp(-s / decay);
      },
      since: (target, t) => idx.since(target, t),
      next: (target, t) => idx.next(target, t),
    };
  }

  render(dl: DrawList, t: number): void {
    const ch = this.choreo;
    if (!ch) return;
    const ctx = this.ctx();
    const pal = ctx.pal;
    const app = this.svc.appearance();
    for (const p of ch.props) if (p.layer !== 'front') p.draw(dl, t, ctx);
    // balls: only those whose lifetime overlaps t (binary search on start times)
    const hi = lastIndexAtOrBefore(this.ballStarts, t);
    const s = this.sample;
    for (let i = hi; i >= 0; i--) {
      const b = this.sortedBalls[i];
      if (t - this.ballStarts[i] > this.maxBallSpan) break;
      sampleActor(b, t, s);
      if (!s.visible) continue;
      const c = b.color ?? pal.voices[b.voice];
      if (app.trails) {
        const len = app.trailLength;
        drawSampledTrail(
          dl,
          (tt) => {
            const q = sampleActor(b, tt, { x: 0, y: 0, visible: false, alpha: 1, scale: 1 });
            return q.visible ? q : null;
          },
          t,
          len,
          b.r * s.scale,
          c,
          12,
        );
      }
      let flash = 0;
      if (b.hits.length && app.highlights) {
        const k = lastIndexAtOrBefore(b.hits, t);
        if (k >= 0) flash = Math.exp(-(t - b.hits[k]) / 0.12);
      }
      dl.ball(s.x, s.y, b.r * s.scale, c, s.alpha, (s.x / Math.max(0.05, b.r)) * 0.6, flash);
    }
    for (const p of ch.props) if (p.layer === 'front') p.draw(dl, t, ctx);
    // deterministic sparks for recent activations
    if (app.particles) {
      const last = lastIndexAtOrBefore(this.actTimes, t);
      for (let i = last; i >= 0; i--) {
        const a = ch.acts[i];
        const age = t - a.time;
        if (age > 0.55) break;
        const n = Math.round(5 * app.particleDensity);
        const c = a.notes.length ? pal.voices[a.voice] : pal.dim;
        for (let k = 0; k < n; k++) {
          const ang = Math.atan2(a.ny, a.nx) + (hash01(i, k) - 0.5) * 2.4;
          const sp = 1.2 + hash01(k, i) * 2.8;
          const x = a.x + Math.cos(ang) * sp * age;
          const y = a.y + Math.sin(ang) * sp * age - 3 * age * age;
          const f = 1 - age / 0.55;
          dl.spark(x, y, 0.06 + 0.06 * f, c, f * f);
        }
      }
    }
    if (this.svc.camera.mode === 'follow') {
      const f = ch.focus?.(t) ?? this.defaultFocus(t);
      this.svc.camera.setFocus(f.x, f.y, f.h);
    }
    void TAU;
  }

  private defaultFocus(t: number): { x: number; y: number; h: number } {
    const ch = this.choreo!;
    // anticipatory framing: weight upcoming activations in the next 1.5 s
    let sx = 0;
    let sy = 0;
    let w = 0;
    const i0 = Math.max(0, lastIndexAtOrBefore(this.actTimes, t - 0.3));
    for (let i = i0; i < ch.acts.length; i++) {
      const a = ch.acts[i];
      if (a.time > t + 1.5) break;
      const k = 1 / (1 + Math.abs(a.time - t) * 2);
      sx += a.x * k;
      sy += a.y * k;
      w += k;
    }
    const b = ch.bounds;
    const bh = b.maxY - b.minY;
    if (!w) return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, h: bh };
    return { x: sx / w, y: sy / w, h: Math.max(8, bh * 0.55) };
  }

  stats(): [string, string][] {
    const n = this.events.reduce((s, e) => s + e.notes.length, 0);
    return [
      ['Notes', String(n)],
      ['Activations', String(this.events.length)],
      ['Balls', String(this.choreo?.balls.length ?? 0)],
    ];
  }

  loopInfo(): string {
    return 'Choreographed performance — deterministic: restart replays it identically, and every note is struck by a visible mechanism at its score time. Not a loop.';
  }

  dispose(): void {}
}
