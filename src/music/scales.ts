export const SCALES: Record<string, { label: string; steps: number[] }> = {
  majorPent: { label: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  minorPent: { label: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  major: { label: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'Natural minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  lydian: { label: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  harmonicMinor: { label: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  wholeTone: { label: 'Whole tone', steps: [0, 2, 4, 6, 8, 10] },
  chromatic: { label: 'Chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

export const ROOTS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export function scaleOptions(): { value: string; label: string }[] {
  return Object.entries(SCALES).map(([value, s]) => ({ value, label: s.label }));
}

export function rootOptions(): { value: string; label: string }[] {
  return ROOTS.map((label, i) => ({ value: String(i), label }));
}

/** scale degree (0 = root, may be negative or exceed one octave) → MIDI pitch */
export function degreeToMidi(degree: number, rootPc: number, scale: string, baseOctave = 4): number {
  const steps = (SCALES[scale] ?? SCALES.majorPent).steps;
  const n = steps.length;
  const d = Math.round(degree);
  const oct = Math.floor(d / n);
  const idx = ((d % n) + n) % n;
  return 12 * (baseOctave + 1) + rootPc + steps[idx] + 12 * oct;
}

export type ChordKind = 'none' | 'octave' | 'fifth' | 'triad' | 'seventh';

/** scale-degree offsets for a chord built on a degree (diatonic stacking in thirds) */
export function chordDegrees(kind: ChordKind, scale: string): number[] {
  const n = (SCALES[scale] ?? SCALES.majorPent).steps.length;
  switch (kind) {
    case 'octave':
      return [0, n];
    case 'fifth':
      return n === 7 ? [0, 4] : [0, Math.round(n * 0.6)];
    case 'triad':
      return n === 7 ? [0, 2, 4] : [0, 1, 2];
    case 'seventh':
      return n === 7 ? [0, 2, 4, 6] : [0, 1, 2, 3];
    default:
      return [0];
  }
}
