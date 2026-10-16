import { defaultMusic, type Layout, type LayoutElement, type ElementKind, type MusicProps } from './layout.ts';
import type { InstrumentId } from '../../audio/instruments.ts';

let nextId = 1;
function el(kind: ElementKind, x1: number, y1: number, x2: number, y2: number, r = 0, music: MusicProps | null = null): LayoutElement {
  return { id: nextId++, kind, x1, y1, x2, y2, r, music };
}
const m = (degree: number, instrument: InstrumentId = 'marimba', extra: Partial<MusicProps> = {}): MusicProps => ({ ...defaultMusic(degree, instrument), ...extra });

function chimeStairs(): Layout {
  nextId = 1;
  const els: LayoutElement[] = [];
  // side rails
  els.push(el('wall', -8, 11, -8, -9));
  els.push(el('wall', 8, 11, 8, -9));
  // zig-zag tuned pads
  const rows = 6;
  for (let i = 0; i < rows; i++) {
    const y = 7 - i * 2.4;
    const left = i % 2 === 0;
    const x1 = left ? -6.6 : 6.6;
    const x2 = left ? -1.2 : 1.2;
    els.push(el('pad', x1, y + 0.55, x2, y - 0.25, 0, m(i * 2, i % 3 === 2 ? 'glass' : 'marimba')));
  }
  // note gates on the way down
  els.push(el('gate', -0.6, 4.2, 0.6, 4.2, 0, m(7, 'glass')));
  els.push(el('gate', -0.6, -0.6, 0.6, -0.6, 0, m(9, 'glass')));
  // bumpers around the funnel
  els.push(el('bumper', -4.2, -6.3, 0, 0, 0.55, m(4, 'bell')));
  els.push(el('bumper', 4.2, -6.3, 0, 0, 0.55, m(5, 'bell')));
  els.push(el('funnel', -3, -7.2, 3, -7.2, 0.45));
  els.push(el('ramp', -7.8, -9.4, 7.8, -9.4));
  return { schema: 'musical-marbles/layout@1', name: 'Chime staircase', spawner: { x: -6.2, y: 9.6, angle: -0.25 }, elements: els };
}

function bumperGarden(): Layout {
  nextId = 1;
  const els: LayoutElement[] = [];
  els.push(el('wall', -8, 11, -8, -9));
  els.push(el('wall', 8, 11, 8, -9));
  let d = 0;
  for (let row = 0; row < 5; row++) {
    const n = row % 2 === 0 ? 5 : 4;
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * 3;
      const y = 6 - row * 2.8;
      els.push(el('bumper', x, y, 0, 0, 0.45 + (row % 2) * 0.1, m((d++ * 3) % 14, row % 2 ? 'bell' : 'glass', { chord: row === 4 ? 'fifth' : 'none' })));
    }
  }
  els.push(el('pad', -7.8, -7.5, -2, -9, 0, m(-5, 'pluck')));
  els.push(el('pad', 7.8, -7.5, 2, -9, 0, m(-3, 'pluck')));
  return { schema: 'musical-marbles/layout@1', name: 'Bumper garden', spawner: { x: 0, y: 10, angle: -Math.PI / 2 }, elements: els };
}

function sequencerRun(): Layout {
  nextId = 1;
  const els: LayoutElement[] = [];
  els.push(el('wall', -8, 11, -8, -9));
  els.push(el('wall', 8, 11, 8, -9));
  els.push(el('ramp', -7.5, 8, 3, 5.5));
  els.push(el('pad', 7.6, 6.2, 5.2, 3.8, 0, m(0, 'pluck', { sequence: true, seqStep: 2, seqLength: 4 })));
  els.push(el('ramp', 4, 2.5, -5, 0.5));
  for (let i = 0; i < 4; i++) els.push(el('gate', 2.5 - i * 2.2, 2.8 - i * 0.45, 2.5 - i * 2.2, 1.5 - i * 0.45, 0, m(4 + i, 'arcade')));
  els.push(el('pad', -7.6, 0.8, -5.4, -1.8, 0, m(2, 'marimba', { chord: 'triad' })));
  els.push(el('ramp', -5, -3, 5, -5));
  els.push(el('bumper', 6.3, -5.4, 0, 0, 0.7, m(-1, 'bell', { sequence: true, seqStep: 1, seqLength: 3 })));
  els.push(el('funnel', -4, -7, 2, -7, 0.4));
  return { schema: 'musical-marbles/layout@1', name: 'Sequencer run', spawner: { x: -6.8, y: 9.8, angle: -0.15 }, elements: els };
}

function blank(): Layout {
  nextId = 1;
  return { schema: 'musical-marbles/layout@1', name: 'Blank', spawner: { x: 0, y: 9.5, angle: -Math.PI / 2 }, elements: [el('ramp', -7.5, -8.5, 7.5, -8.5)] };
}

export const BUILDER_PRESETS: { id: string; label: string; make: () => Layout }[] = [
  { id: 'stairs', label: 'Chime staircase', make: chimeStairs },
  { id: 'garden', label: 'Bumper garden', make: bumperGarden },
  { id: 'sequencer', label: 'Sequencer run', make: sequencerRun },
  { id: 'blank', label: 'Blank', make: blank },
];
