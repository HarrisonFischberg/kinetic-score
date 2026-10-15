// Contract between the app shell and every scene (playground or performance).
import type { AudioEngine } from '../audio/engine.ts';
import type { ShepardEngine } from '../audio/shepard.ts';
import type { InstrumentId } from '../audio/instruments.ts';
import type { CameraController, Bounds } from '../rendering/camera.ts';
import type { DrawList } from '../rendering/draw.ts';
import type { Particles, Trails } from '../rendering/effects.ts';
import type { Palette } from '../rendering/palette.ts';

export type ParamValue = number | string | boolean;

export interface ParamOption {
  value: string;
  label: string;
  /** reason the option is unavailable (rendered disabled) */
  disabled?: string;
}

export interface ParamDef {
  key: string;
  label: string;
  type: 'range' | 'select' | 'toggle' | 'button';
  min?: number;
  max?: number;
  step?: number;
  options?: ParamOption[];
  /** live = applies immediately; restart = takes effect when the scene restarts */
  applies: 'live' | 'restart';
  group?: string;
  hint?: string;
  unit?: string;
  /** hide unless predicate holds */
  visible?: (values: Record<string, ParamValue>) => boolean;
}

export interface Appearance {
  palette: string;
  glow: number;
  trails: boolean;
  trailLength: number;
  particles: boolean;
  particleDensity: number;
  noteLabels: boolean;
  highlights: boolean;
  showTitle: boolean;
  showCounters: boolean;
  grid: number;
}

export function defaultAppearance(): Appearance {
  return { palette: 'neon', glow: 1, trails: true, trailLength: 0.45, particles: true, particleDensity: 1, noteLabels: true, highlights: true, showTitle: true, showCounters: false, grid: 1 };
}

export interface SceneServices {
  audio: AudioEngine;
  shepard: ShepardEngine;
  camera: CameraController;
  particles: Particles;
  trails: Trails;
  palette(): Palette;
  appearance(): Appearance;
  /** global seed; scenes derive all randomness from it on reset */
  seed(): number;
  notify(msg: string, kind?: 'info' | 'warn'): void;
  /** request the panel to re-render scene controls (e.g. after selection changes) */
  refreshControls(): void;
  /** a timeline scene changed its events: reschedule from the current position */
  timelineChanged?(): void;
}

export interface SceneInfo {
  id: string;
  title: string;
  mode: 'playground' | 'performance';
  blurb: string;
  /** honest label about how motion and sound relate */
  motion: string;
}

export interface ScenePointer {
  type: 'down' | 'move' | 'up' | 'cancel';
  x: number;
  y: number;
  /** world units per CSS pixel, for hit tolerances */
  pxSize: number;
  button: number;
  shift: boolean;
  pointerId: number;
}

export interface PerfNote {
  pitch: number;
  vel: number;
  dur: number;
  inst: InstrumentId;
}

/** One audible activation of a visible mechanism. */
export interface PerfEvent {
  time: number;
  notes: PerfNote[];
  pan: number;
  /** id of the prop that visibly produces it */
  target: string;
}

export interface PerformanceInfo {
  songId: string;
  duration: number;
  events: PerfEvent[];
  /** current phrase label at time t, for the title overlay */
  phraseAt(t: number): string;
  /** the timeline repeats exactly with this period (seconds) */
  loop?: number;
}

export interface Scene {
  readonly info: SceneInfo;
  readonly params: ParamDef[];
  values: Record<string, ParamValue>;
  init(svc: SceneServices): void;
  /** Restore the scene's starting state exactly (layout, balls, seed, counters). */
  reset(): void;
  /** Advance simulation by dt seconds of scene time (playground scenes). */
  update(dt: number, t: number): void;
  render(dl: DrawList, t: number, dt: number): void;
  /** Screen-space overlay (in HUD units). */
  hud?(dl: DrawList, t: number, aspect: number): void;
  onParam?(key: string): void;
  pointer?(p: ScenePointer): boolean;
  keydown?(e: KeyboardEvent): boolean;
  bounds(): Bounds;
  stats?(): [string, string][];
  /** describes looping behaviour honestly */
  loopInfo?(): string;
  performance?(): PerformanceInfo | null;
  /** transport started or stopped (continuous engines use this to fade in/out) */
  setPlaying?(playing: boolean): void;
  /** safe randomisation of scene parameters (seed already changed by the app) */
  randomize?(rand: () => number): void;
  dispose(): void;
}
