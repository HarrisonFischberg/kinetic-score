// Editable playground layout: plain data, versioned and validated on import.
import { isInstrument, type InstrumentId } from '../../audio/instruments.ts';
import type { ChordKind } from '../../music/scales.ts';

export type ElementKind = 'ramp' | 'wall' | 'bumper' | 'funnel' | 'pad' | 'gate';
export const ELEMENT_KINDS: ElementKind[] = ['ramp', 'wall', 'bumper', 'funnel', 'pad', 'gate'];

export type Retrigger = 'cooldown' | 'always' | 'mono';

export interface MusicProps {
  degree: number;
  instrument: InstrumentId;
  /** 0 = every hit at full velocity, 1 = velocity follows impact speed */
  velSens: number;
  retrigger: Retrigger;
  cooldownMs: number;
  chord: ChordKind;
  /** advance the degree by `seqStep` each hit, cycling through `seqLength` steps */
  sequence: boolean;
  seqStep: number;
  seqLength: number;
}

export interface LayoutElement {
  id: number;
  kind: ElementKind;
  /** line-like elements: endpoints; bumper: centre (x1,y1) and radius r; funnel: rim endpoints and gap r */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  r: number;
  music: MusicProps | null;
}

export interface Spawner {
  x: number;
  y: number;
  angle: number;
}

export interface Layout {
  schema: 'kinetic-score/layout@1';
  name: string;
  spawner: Spawner;
  elements: LayoutElement[];
}

export const MUSICAL_KINDS: ElementKind[] = ['pad', 'gate', 'bumper'];

export function defaultMusic(degree = 0, instrument: InstrumentId = 'marimba'): MusicProps {
  return { degree, instrument, velSens: 0.6, retrigger: 'cooldown', cooldownMs: 90, chord: 'none', sequence: false, seqStep: 1, seqLength: 4 };
}

export function cloneLayout(l: Layout): Layout {
  return JSON.parse(JSON.stringify(l)) as Layout;
}

const MAX_ELEMENTS = 300;
const LIMIT = 200;

function num(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/** Validate untrusted layout JSON; returns errors (empty = ok). */
export function validateLayout(raw: unknown): string[] {
  const errs: string[] = [];
  if (!raw || typeof raw !== 'object') return ['Layout must be a JSON object.'];
  const l = raw as Record<string, unknown>;
  if (l.schema !== 'kinetic-score/layout@1') errs.push('schema must be "kinetic-score/layout@1".');
  if (typeof l.name !== 'string' || l.name.length > 80) errs.push('name must be a string (≤80 chars).');
  const sp = l.spawner as Record<string, unknown> | undefined;
  if (!sp || !num(sp.x, -LIMIT, LIMIT) || !num(sp.y, -LIMIT, LIMIT) || !num(sp.angle, -10, 10)) errs.push('spawner needs numeric x, y, angle.');
  if (!Array.isArray(l.elements)) {
    errs.push('elements must be an array.');
    return errs;
  }
  if (l.elements.length > MAX_ELEMENTS) errs.push(`At most ${MAX_ELEMENTS} elements.`);
  const ids = new Set<number>();
  (l.elements as unknown[]).slice(0, MAX_ELEMENTS).forEach((e, i) => {
    if (errs.length > 20) return;
    const o = e as Record<string, unknown>;
    if (!o || typeof o !== 'object') return void errs.push(`elements[${i}] must be an object.`);
    if (!Number.isInteger(o.id) || ids.has(o.id as number)) errs.push(`elements[${i}].id must be a unique integer.`);
    ids.add(o.id as number);
    if (!ELEMENT_KINDS.includes(o.kind as ElementKind)) errs.push(`elements[${i}].kind must be one of ${ELEMENT_KINDS.join(', ')}.`);
    for (const k of ['x1', 'y1', 'x2', 'y2']) if (!num(o[k], -LIMIT, LIMIT)) errs.push(`elements[${i}].${k} must be a number within ±${LIMIT}.`);
    if (!num(o.r, 0, 20)) errs.push(`elements[${i}].r must be a number 0–20.`);
    if (o.music !== null && o.music !== undefined) {
      const m = o.music as Record<string, unknown>;
      if (!num(m.degree, -40, 40)) errs.push(`elements[${i}].music.degree must be −40…40.`);
      if (!isInstrument(m.instrument)) errs.push(`elements[${i}].music.instrument is not a known voice.`);
      if (!num(m.velSens, 0, 1)) errs.push(`elements[${i}].music.velSens must be 0–1.`);
      if (!['cooldown', 'always', 'mono'].includes(m.retrigger as string)) errs.push(`elements[${i}].music.retrigger is invalid.`);
      if (!num(m.cooldownMs, 0, 5000)) errs.push(`elements[${i}].music.cooldownMs must be 0–5000.`);
      if (!['none', 'octave', 'fifth', 'triad', 'seventh'].includes(m.chord as string)) errs.push(`elements[${i}].music.chord is invalid.`);
      if (typeof m.sequence !== 'boolean' || !num(m.seqStep, -12, 12) || !num(m.seqLength, 1, 16)) errs.push(`elements[${i}].music sequence fields are invalid.`);
    }
  });
  return errs;
}

export function hasMusic(kind: ElementKind): boolean {
  return MUSICAL_KINDS.includes(kind);
}
