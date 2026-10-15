import { hexToRgb, hsl } from '../core/math.ts';
import type { RGB } from './draw.ts';
import type { VoiceRole } from '../music/score.ts';

export interface Palette {
  id: string;
  label: string;
  bgTop: RGB;
  bgBottom: RGB;
  grid: RGB;
  track: RGB;
  structure: RGB;
  text: RGB;
  dim: RGB;
  accent: RGB;
  voices: Record<VoiceRole, RGB>;
  /** base hue for generative colouring, and spread */
  hue: number;
  hueSpread: number;
  sat: number;
}

const P = (hex: string): RGB => hexToRgb(hex);

export const PALETTES: Palette[] = [
  {
    id: 'neon',
    label: 'Neon night',
    bgTop: P('#0b0d24'),
    bgBottom: P('#03040b'),
    grid: P('#2a3270'),
    track: P('#5ad1ff'),
    structure: P('#7c84c9'),
    text: P('#eef1ff'),
    dim: P('#7d84b8'),
    accent: P('#ff5fd2'),
    voices: { melody: P('#ffd166'), counter: P('#ff6fb5'), accomp: P('#5ad1ff'), bass: P('#8f7bff') },
    hue: 0.55,
    hueSpread: 0.45,
    sat: 0.85,
  },
  {
    id: 'aurora',
    label: 'Aurora',
    bgTop: P('#04161d'),
    bgBottom: P('#01060a'),
    grid: P('#174a4a'),
    track: P('#59f0c2'),
    structure: P('#6aa8a0'),
    text: P('#eafff8'),
    dim: P('#6f9d95'),
    accent: P('#b388ff'),
    voices: { melody: P('#f4f78a'), counter: P('#b388ff'), accomp: P('#59f0c2'), bass: P('#4aa3ff') },
    hue: 0.42,
    hueSpread: 0.35,
    sat: 0.75,
  },
  {
    id: 'ember',
    label: 'Ember',
    bgTop: P('#1c0a0c'),
    bgBottom: P('#070203'),
    grid: P('#4a1d22'),
    track: P('#ff9a52'),
    structure: P('#b86a5a'),
    text: P('#fff1e6'),
    dim: P('#a2766c'),
    accent: P('#ffd36b'),
    voices: { melody: P('#ffe08a'), counter: P('#ff7a59'), accomp: P('#ff4f7b'), bass: P('#c86bff') },
    hue: 0.03,
    hueSpread: 0.14,
    sat: 0.9,
  },
  {
    id: 'ice',
    label: 'Ice',
    bgTop: P('#0a1426'),
    bgBottom: P('#02050c'),
    grid: P('#1f3a63'),
    track: P('#9fd8ff'),
    structure: P('#7fa0c8'),
    text: P('#f2f8ff'),
    dim: P('#7f95b3'),
    accent: P('#e0f4ff'),
    voices: { melody: P('#ffffff'), counter: P('#9fd8ff'), accomp: P('#6c9cff'), bass: P('#b39cff') },
    hue: 0.58,
    hueSpread: 0.12,
    sat: 0.6,
  },
  {
    id: 'paper',
    label: 'Ink on night',
    bgTop: P('#16161a'),
    bgBottom: P('#0a0a0c'),
    grid: P('#2c2c34'),
    track: P('#e8e8ee'),
    structure: P('#8a8a96'),
    text: P('#ffffff'),
    dim: P('#9a9aa6'),
    accent: P('#ff4d4d'),
    voices: { melody: P('#ff4d4d'), counter: P('#ffffff'), accomp: P('#9aa0ff'), bass: P('#ffb84d') },
    hue: 0.0,
    hueSpread: 1,
    sat: 0.55,
  },
];

export function getPalette(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

/** generative colour from a 0..1 value, within the palette's hue band */
export function paletteHue(p: Palette, t: number, light = 0.62): RGB {
  return hsl(p.hue + (t - 0.5) * p.hueSpread, p.sat, light);
}

/** colour for a MIDI pitch: pitch class around the palette band */
export function pitchColor(p: Palette, midi: number): RGB {
  const pc = (((midi % 12) + 12) % 12) / 12;
  return hsl(p.hue + (pc - 0.5) * Math.max(0.35, p.hueSpread), p.sat, 0.64);
}
