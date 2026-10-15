// Score data model, validation and timing helpers shared by every performance scene.

export type VoiceRole = 'melody' | 'counter' | 'accomp' | 'bass';
export const VOICE_ROLES: readonly VoiceRole[] = ['melody', 'counter', 'accomp', 'bass'];

export interface ScoreNote {
  /** onset in quarter-note beats from the excerpt start */
  t: number;
  /** duration in quarter-note beats */
  d: number;
  /** MIDI pitch */
  p: number;
  /** velocity 0..1 */
  v: number;
  voice: VoiceRole;
}

export interface ScoreSource {
  collection: string;
  mutopiaId?: number;
  url?: string;
  file?: string;
  edition: string;
  license: string;
  note: string;
  excerptQuarterRange?: [number, number];
}

export interface ScoreData {
  schema: 'kinetic-score/score@1';
  id: string;
  composer: string;
  title: string;
  work: string;
  catalog: string;
  movement: string;
  excerpt: string;
  priority: boolean;
  source: ScoreSource;
  arrangement: string[];
  tempo: { bpm: number; beatUnit: 'quarter'; rampTo: number };
  meter: { numerator: number; denominator: number };
  pickupBeats: number;
  durationBeats: number;
  phrases: { t: number; label: string }[];
  notes: ScoreNote[];
}

/** A note placed on the shared timeline (seconds from performance start). */
export interface TimedNote {
  index: number;
  time: number;
  dur: number;
  pitch: number;
  vel: number;
  voice: VoiceRole;
}

export interface NoteGroup {
  time: number;
  notes: TimedNote[];
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export function noteName(p: number, withOctave = true): string {
  const n = NOTE_NAMES[((p % 12) + 12) % 12];
  return withOctave ? `${n}${Math.floor(p / 12) - 1}` : n;
}

export function midiToFreq(p: number): number {
  return 440 * Math.pow(2, (p - 69) / 12);
}

const MAX_NOTES = 5000;

/** Validates untrusted score JSON. Returns a list of human-readable problems (empty = valid). */
export function validateScore(raw: unknown): string[] {
  const errs: string[] = [];
  if (!raw || typeof raw !== 'object') return ['Score must be a JSON object.'];
  const s = raw as Record<string, unknown>;
  if (s.schema !== 'kinetic-score/score@1') errs.push('schema must be "kinetic-score/score@1".');
  for (const k of ['id', 'composer', 'title', 'work', 'movement', 'excerpt']) {
    if (typeof s[k] !== 'string' || !(s[k] as string).length || (s[k] as string).length > 300) errs.push(`${k} must be a non-empty string (≤300 chars).`);
  }
  if (typeof s.id === 'string' && !/^[a-z0-9-]{1,64}$/.test(s.id)) errs.push('id may only contain a-z, 0-9 and "-".');
  const src = s.source as Record<string, unknown> | undefined;
  if (!src || typeof src !== 'object') errs.push('source is required (collection, edition, license, note).');
  else for (const k of ['collection', 'edition', 'license', 'note']) if (typeof src[k] !== 'string') errs.push(`source.${k} must be a string.`);
  const tempo = s.tempo as Record<string, unknown> | undefined;
  if (!tempo || typeof tempo.bpm !== 'number' || !(tempo.bpm >= 20 && tempo.bpm <= 300)) errs.push('tempo.bpm must be a number between 20 and 300.');
  if (tempo && tempo.rampTo !== undefined && !(typeof tempo.rampTo === 'number' && tempo.rampTo >= 0.5 && tempo.rampTo <= 2)) errs.push('tempo.rampTo must be between 0.5 and 2.');
  const meter = s.meter as Record<string, unknown> | undefined;
  if (!meter || !Number.isInteger(meter.numerator) || !Number.isInteger(meter.denominator) || (meter.numerator as number) < 1 || (meter.numerator as number) > 16 || ![2, 4, 8, 16].includes(meter.denominator as number)) errs.push('meter must have integer numerator 1–16 and denominator 2/4/8/16.');
  if (typeof s.durationBeats !== 'number' || !(s.durationBeats > 0 && s.durationBeats < 2000)) errs.push('durationBeats must be a positive number.');
  if (!Array.isArray(s.phrases)) errs.push('phrases must be an array.');
  if (!Array.isArray(s.arrangement)) errs.push('arrangement must be an array of strings.');
  if (!Array.isArray(s.notes) || s.notes.length === 0) {
    errs.push('notes must be a non-empty array.');
    return errs;
  }
  if (s.notes.length > MAX_NOTES) errs.push(`At most ${MAX_NOTES} notes are supported.`);
  let prev = -Infinity;
  (s.notes as unknown[]).slice(0, MAX_NOTES).forEach((n, i) => {
    if (errs.length > 20) return;
    const o = n as Record<string, unknown>;
    if (!o || typeof o !== 'object') {
      errs.push(`notes[${i}] must be an object.`);
      return;
    }
    if (typeof o.t !== 'number' || !Number.isFinite(o.t) || o.t < 0) errs.push(`notes[${i}].t must be a non-negative number.`);
    else {
      if (o.t < prev) errs.push(`notes[${i}] is out of order (notes must be sorted by t).`);
      prev = o.t;
      if (typeof s.durationBeats === 'number' && o.t > s.durationBeats) errs.push(`notes[${i}] starts after durationBeats.`);
    }
    if (typeof o.d !== 'number' || !(o.d > 0 && o.d <= 64)) errs.push(`notes[${i}].d must be in (0, 64].`);
    if (!Number.isInteger(o.p) || (o.p as number) < 21 || (o.p as number) > 108) errs.push(`notes[${i}].p must be an integer MIDI pitch 21–108.`);
    if (typeof o.v !== 'number' || !(o.v >= 0 && o.v <= 1)) errs.push(`notes[${i}].v must be in [0, 1].`);
    if (!VOICE_ROLES.includes(o.voice as VoiceRole)) errs.push(`notes[${i}].voice must be one of ${VOICE_ROLES.join(', ')}.`);
  });
  return errs;
}

/** Seconds elapsed at a given beat, with an optional linear tempo ramp across the excerpt. */
export function beatToSeconds(beat: number, score: Pick<ScoreData, 'tempo' | 'durationBeats'>, tempoScale = 1): number {
  const bpm = score.tempo.bpm * tempoScale;
  const r = score.tempo.rampTo ?? 1;
  if (Math.abs(r - 1) < 1e-6) return (beat * 60) / bpm;
  const k = (r - 1) / score.durationBeats;
  return ((60 / bpm) * Math.log(1 + k * beat)) / k;
}

/** Convert score notes to absolute times, sorted, with a lead-in offset. */
export function timeNotes(score: ScoreData, tempoScale = 1, leadIn = 0): TimedNote[] {
  return score.notes
    .map((n, i) => {
      const time = leadIn + beatToSeconds(n.t, score, tempoScale);
      const end = leadIn + beatToSeconds(n.t + n.d, score, tempoScale);
      return { index: i, time, dur: Math.max(0.05, end - time), pitch: n.p, vel: n.v, voice: n.voice };
    })
    .sort((a, b) => a.time - b.time || a.pitch - b.pitch);
}

/** Group notes whose onsets lie within `epsilon` seconds of each other (chords). */
export function groupSimultaneous(notes: TimedNote[], epsilon = 0.012): NoteGroup[] {
  const groups: NoteGroup[] = [];
  for (const n of notes) {
    const g = groups[groups.length - 1];
    if (g && n.time - g.time <= epsilon) g.notes.push(n);
    else groups.push({ time: n.time, notes: [n] });
  }
  return groups;
}

export function scoreDurationSeconds(score: ScoreData, tempoScale = 1): number {
  return beatToSeconds(score.durationBeats, score, tempoScale);
}

export function notesByVoice(notes: TimedNote[], voice: VoiceRole): TimedNote[] {
  return notes.filter((n) => n.voice === voice);
}
