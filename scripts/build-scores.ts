// Builds src/music/scores/*.json from the Mutopia Project MIDI files in score-src/.
// Run: node scripts/build-scores.ts
//
// Each excerpt is an original simplified arrangement of a public-domain work:
// we select a passage, assign musical roles (melody / counter / accompaniment /
// bass), drop very short ornaments that a kinetic mechanism cannot articulate,
// optionally transpose for clarity on synthesized voices, and record every one
// of those decisions in the JSON so the data stays inspectable.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMidi } from '../src/music/midi.ts';
import type { ScoreData, ScoreNote, VoiceRole } from '../src/music/score.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

interface TrackCfg {
  index: number;
  /** fixed role, or split simultaneous notes: highest note gets `top`, the rest `rest` */
  role?: VoiceRole;
  split?: { top: VoiceRole; rest: VoiceRole } | { bottom: VoiceRole; rest: VoiceRole };
  transpose?: number;
  /** custom role by onset position within a 2-beat half bar (used for the Bach prelude's held notes) */
  byHalfBar?: { onBeat: VoiceRole; offBeat: VoiceRole };
}

interface PieceCfg {
  id: string;
  file: string;
  composer: string;
  title: string;
  work: string;
  catalog: string;
  movement: string;
  excerpt: string;
  mutopiaId: number;
  edition: string;
  license: string;
  licenseNote: string;
  startQ: number;
  endQ: number;
  bpm: number;
  meter: [number, number];
  /** quarter-note offset of the first full bar from startQ (pickup length) */
  pickupQ: number;
  tracks: TrackCfg[];
  minDurQ: number;
  tempoRamp?: number;
  /** extra notes appended by the arrangement (e.g. a closing chord) */
  addNotes?: ScoreNote[];
  /** truncate notes that start at endQ-?..; we keep notes starting < endQ */
  phrases: { q: number; label: string }[];
  arrangement: string[];
  priority: boolean;
}

const MUTOPIA = (id: number) => `https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=${id}`;

const pieces: PieceCfg[] = [
  {
    id: 'canon-in-d',
    file: 'Canon_per_3_Violini_e_Basso-mids/canon_per_3_violini_e_basso.mid',
    composer: 'Johann Pachelbel',
    title: 'Canon in D',
    work: 'Canon and Gigue in D major for three violins and basso continuo',
    catalog: 'P. 37',
    movement: 'Canon',
    excerpt: 'Bars 1–16 (ground bass, then the three violin entries), closing on the bar-17 downbeat',
    mutopiaId: 2047,
    edition: 'Mutopia typesetting of a public-domain edition listed by Mutopia as "IMSLP"',
    license: 'CC BY 4.0 (typesetting); the 17th-century composition is public domain',
    licenseNote: 'Mutopia typesetting released under Creative Commons Attribution 4.0 — attribution to the Mutopia Project and the typesetter is given here and in the About panel.',
    startQ: 0,
    endQ: 64,
    bpm: 58,
    meter: [4, 4],
    pickupQ: 0,
    tracks: [
      { index: 1, role: 'melody' },
      { index: 2, role: 'counter' },
      { index: 3, role: 'accomp' },
      { index: 4, role: 'bass' },
    ],
    minDurQ: 0.2,
    addNotes: [
      { t: 64, d: 3, p: 86, v: 0.8, voice: 'melody' },
      { t: 64, d: 3, p: 66, v: 0.7, voice: 'counter' },
      { t: 64, d: 3, p: 62, v: 0.7, voice: 'accomp' },
      { t: 64, d: 3, p: 50, v: 0.85, voice: 'bass' },
    ],
    phrases: [
      { q: 0, label: 'Ground bass' },
      { q: 8, label: 'Violin I enters' },
      { q: 16, label: 'Violin II enters' },
      { q: 24, label: 'Violin III enters' },
      { q: 32, label: 'Variation: quavers' },
      { q: 48, label: 'Variation: semiquavers' },
      { q: 64, label: 'Final chord' },
    ],
    arrangement: [
      'Notes taken unchanged from the Mutopia MIDI for bars 1–16.',
      'Closing D-major chord on the bar-17 downbeat added by this arrangement (the original continues).',
    ],
    priority: true,
  },
  {
    id: 'fur-elise',
    file: 'fur_Elise_WoO59.mid',
    composer: 'Ludwig van Beethoven',
    title: 'Für Elise',
    work: 'Bagatelle No. 25 in A minor',
    catalog: 'WoO 59',
    movement: 'Poco moto (A section)',
    excerpt: 'Opening A section with its middle phrase and return (bars 1–22 as unfolded in the source, with repeat)',
    mutopiaId: 931,
    edition: 'Breitkopf & Härtel, 1888 (as listed by Mutopia)',
    license: 'Public Domain',
    licenseNote: 'Mutopia lists both the edition and the typesetting as public domain.',
    startQ: 0,
    endQ: 33.5,
    bpm: 66,
    meter: [3, 8],
    pickupQ: 0.5,
    tracks: [
      { index: 1, split: { top: 'melody', rest: 'accomp' } },
      { index: 2, split: { bottom: 'bass', rest: 'accomp' } },
    ],
    minDurQ: 0.1,
    phrases: [
      { q: 0, label: 'Theme' },
      { q: 5.75, label: 'Theme answer' },
      { q: 11.75, label: 'Theme (repeat)' },
      { q: 17.0, label: 'Middle phrase' },
      { q: 27.5, label: 'Theme returns' },
    ],
    arrangement: [
      'Right-hand part split: top note = melody, other right-hand notes = accompaniment.',
      'Left-hand part: lowest note of each onset = bass, others = accompaniment.',
      'Excerpt ends on the A of the cadence before the F-major episode.',
    ],
    priority: true,
  },
  {
    id: 'ode-to-joy',
    file: 'ode.mid',
    composer: 'Ludwig van Beethoven',
    title: 'Ode to Joy',
    work: 'Symphony No. 9 in D minor, Op. 125 — finale theme ("Freude, schöner Götterfunken"), in a four-part hymn setting',
    catalog: 'Op. 125',
    movement: 'IV. Finale — main theme (hymn-tune setting "Hymn to Joy")',
    excerpt: 'Complete 16-bar theme (A A′ B A′) in G major',
    mutopiaId: 528,
    edition: 'Mutopia hymn setting; source listed as "Various"',
    license: 'Public Domain',
    licenseNote: 'Mutopia lists this hymn typesetting as public domain. This is the theme as a four-part hymn, not the orchestral/choral symphony score.',
    startQ: 0,
    endQ: 64,
    bpm: 100,
    meter: [4, 4],
    pickupQ: 0,
    tracks: [
      { index: 1, split: { top: 'melody', rest: 'counter' } },
      { index: 2, split: { bottom: 'bass', rest: 'accomp' } },
    ],
    minDurQ: 0.2,
    phrases: [
      { q: 0, label: 'Phrase A' },
      { q: 16, label: 'Phrase A′' },
      { q: 32, label: 'Phrase B' },
      { q: 48, label: 'Phrase A′' },
    ],
    arrangement: ['Soprano = melody, alto = counter-line, tenor = accompaniment, bass = bass.'],
    priority: true,
  },
  {
    id: 'rondo-alla-turca',
    file: 'KV331_3_RondoAllaTurca.mid',
    composer: 'Wolfgang Amadeus Mozart',
    title: 'Rondo alla turca',
    work: 'Piano Sonata No. 11 in A major',
    catalog: 'K. 331 (300i)',
    movement: 'III. Alla turca — Allegretto',
    excerpt: 'Opening A-minor theme, its continuation, and the A-major "Turkish" episode (bars 1–48)',
    mutopiaId: 108,
    edition: 'Mutopia typesetting; source listed as "IMSLP" (no specific edition named)',
    license: 'Public Domain',
    licenseNote: 'Mutopia lists the typesetting as public domain.',
    startQ: 0,
    endQ: 96,
    bpm: 120,
    meter: [2, 4],
    pickupQ: 1,
    tracks: [
      { index: 1, split: { top: 'melody', rest: 'counter' } },
      { index: 2, split: { bottom: 'bass', rest: 'accomp' } },
    ],
    minDurQ: 0.1,
    phrases: [
      { q: 0, label: 'Theme (A minor)' },
      { q: 17, label: 'Continuation' },
      { q: 48, label: 'A-major episode' },
      { q: 64, label: 'Semiquaver run' },
      { q: 80, label: 'Cadence' },
    ],
    arrangement: [
      'Grace notes and arpeggiation ticks shorter than a 1/40 bar removed.',
      'Right hand: top = melody, lower octave doubling = counter; left hand: lowest = bass, rest = chords.',
    ],
    priority: false,
  },
  {
    id: 'prelude-c-major',
    file: 'wtk1-prelude1.mid',
    composer: 'Johann Sebastian Bach',
    title: 'Prelude in C major',
    work: 'The Well-Tempered Clavier, Book I — Prelude No. 1',
    catalog: 'BWV 846',
    movement: 'Prelude',
    excerpt: 'Bars 1–19 (arpeggiated chord progression returning to C major), plus closing chord',
    mutopiaId: 5,
    edition: 'Mutopia typesetting; source edition listed as "Unknown"',
    license: 'Public Domain',
    licenseNote: 'Mutopia lists the typesetting as public domain; the underlying edition is not identified.',
    startQ: 0,
    endQ: 76,
    bpm: 72,
    meter: [4, 4],
    pickupQ: 0,
    tracks: [
      { index: 1, byHalfBar: { onBeat: 'bass', offBeat: 'counter' } },
      { index: 2, role: 'melody' },
    ],
    minDurQ: 0.2,
    addNotes: [
      { t: 76, d: 4, p: 48, v: 0.8, voice: 'bass' },
      { t: 76, d: 4, p: 52, v: 0.6, voice: 'counter' },
      { t: 76.5, d: 3.5, p: 55, v: 0.6, voice: 'melody' },
      { t: 77, d: 3, p: 60, v: 0.65, voice: 'melody' },
      { t: 77.5, d: 2.5, p: 64, v: 0.7, voice: 'melody' },
    ],
    phrases: [
      { q: 0, label: 'C major' },
      { q: 16, label: 'Sequence' },
      { q: 32, label: 'Toward G' },
      { q: 44, label: 'Descent' },
      { q: 72, label: 'Return to C' },
    ],
    arrangement: [
      'Lower staff: lowest held note = bass, second held note = counter; upper-staff semiquavers = melody line.',
      'Closing rolled C-major chord after bar 19 added by this arrangement.',
    ],
    priority: false,
  },
  {
    id: 'mountain-king',
    file: 'Dans_l_antre_du_roi_de_la_montagne.mid',
    composer: 'Edvard Grieg',
    title: 'In the Hall of the Mountain King',
    work: 'Peer Gynt Suite No. 1, Op. 46 (piano arrangement in the source)',
    catalog: 'Op. 46 No. 4',
    movement: 'IV. In the Hall of the Mountain King — Alla marcia e molto marcato',
    excerpt: 'Introduction and the first three statements of the theme (bars 1–25)',
    mutopiaId: 1888,
    edition: 'The University Society, New York, 1918 (as listed by Mutopia)',
    license: 'Public Domain',
    licenseNote: 'Mutopia lists the 1918 edition and the typesetting as public domain.',
    startQ: 0,
    endQ: 100,
    bpm: 132,
    meter: [4, 4],
    pickupQ: 0,
    tracks: [
      { index: 1, split: { top: 'melody', rest: 'counter' }, transpose: 24 },
      { index: 2, role: 'bass', transpose: 24 },
    ],
    minDurQ: 0.2,
    tempoRamp: 1.35,
    addNotes: [],
    phrases: [
      { q: 0, label: 'Horn call' },
      { q: 4, label: 'Theme (B minor)' },
      { q: 36, label: 'Theme (F♯)' },
      { q: 68, label: 'Theme returns' },
    ],
    arrangement: [
      'Transposed up two octaves: the source piano reduction places the theme in the bass register, which is muddy on synthesized bells.',
      'Gradual accelerando (to 1.35× the starting tempo) added to mirror the piece’s famous build-up within a short excerpt.',
    ],
    priority: false,
  },
  {
    id: 'eine-kleine',
    file: 'eine-kleine-nachtmusik-mvt1.mid',
    composer: 'Wolfgang Amadeus Mozart',
    title: 'Eine kleine Nachtmusik',
    work: 'Serenade No. 13 in G major for strings',
    catalog: 'K. 525',
    movement: 'I. Allegro',
    excerpt: 'Opening theme and its continuation (bars 1–18)',
    mutopiaId: 900,
    edition: 'Mutopia typesetting; source listed as "IMSLP"',
    license: 'Public Domain',
    licenseNote: 'Mutopia lists the typesetting as public domain.',
    startQ: 0,
    endQ: 70.5,
    bpm: 132,
    meter: [4, 4],
    pickupQ: 0,
    tracks: [
      { index: 1, split: { top: 'melody', rest: 'counter' } },
      { index: 2, role: 'counter' },
      { index: 3, role: 'accomp' },
      { index: 4, role: 'bass' },
    ],
    minDurQ: 0.2,
    phrases: [
      { q: 0, label: 'Mannheim rocket' },
      { q: 16, label: 'Answer' },
      { q: 40, label: 'Transition' },
      { q: 56, label: 'Cadence' },
    ],
    arrangement: ['Ornamental turns (demisemiquavers) omitted; repeated-note semiquaver tremolo kept.'],
    priority: false,
  },
  {
    id: 'brandenburg-1',
    file: 'Brandenburg1-1-mids/score.mid',
    composer: 'Johann Sebastian Bach',
    title: 'Brandenburg Concerto No. 1',
    work: 'Brandenburg Concerto No. 1 in F major',
    catalog: 'BWV 1046',
    movement: 'I. [Allegro]',
    excerpt: 'Opening ritornello to the first F-major cadence (bars 1–12), reduced to four parts',
    mutopiaId: 1136,
    edition: 'Bach-Gesellschaft Ausgabe vol. 19, ed. W. Rust, 1871 (as listed by Mutopia)',
    license: 'CC BY 3.0 (typesetting); the composition and 1871 edition are public domain',
    licenseNote: 'Mutopia typesetting released under Creative Commons Attribution 3.0 — attribution to the Mutopia Project and the typesetter is given here and in the About panel.',
    startQ: 0,
    endQ: 49,
    bpm: 92,
    meter: [4, 4],
    pickupQ: 0,
    tracks: [
      { index: 3, role: 'melody' },
      { index: 1, role: 'counter' },
      { index: 8, role: 'accomp' },
      { index: 12, role: 'bass' },
    ],
    minDurQ: 0.2,
    phrases: [
      { q: 0, label: 'Ritornello' },
      { q: 16, label: 'Horn calls' },
      { q: 32, label: 'Sequence' },
      { q: 44, label: 'Cadence' },
    ],
    arrangement: ['Four-part reduction: Oboe I = melody, Horn I = counter, Violin I = accompaniment, continuo = bass.'],
    priority: false,
  },
];

function round(x: number, p = 1000): number {
  return Math.round(x * p) / p;
}

function build(cfg: PieceCfg): ScoreData {
  const midi = parseMidi(new Uint8Array(readFileSync(join(root, 'score-src', cfg.file))));
  const q = (tick: number) => tick / midi.ppq;
  const notes: ScoreNote[] = [];
  let dropped = 0;
  for (const tc of cfg.tracks) {
    const track = midi.tracks[tc.index];
    if (!track) throw new Error(`${cfg.id}: missing track ${tc.index}`);
    const inRange = track.notes.filter((n) => q(n.tick) >= cfg.startQ - 1e-6 && q(n.tick) < cfg.endQ - 1e-6);
    const byOnset = new Map<number, typeof inRange>();
    for (const n of inRange) {
      if (q(n.durTicks) < cfg.minDurQ) {
        dropped++;
        continue;
      }
      const k = n.tick;
      const arr = byOnset.get(k) ?? [];
      arr.push(n);
      byOnset.set(k, arr);
    }
    for (const group of byOnset.values()) {
      group.sort((a, b) => a.pitch - b.pitch);
      group.forEach((n, i) => {
        let voice: VoiceRole = tc.role ?? 'accomp';
        if (tc.byHalfBar) {
          const pos = (((q(n.tick) - cfg.startQ) % 2) + 2) % 2;
          voice = pos < 1e-3 ? tc.byHalfBar.onBeat : tc.byHalfBar.offBeat;
        } else if (tc.split) {
          // a note only counts as the outer voice if no held note of the same staff sounds beyond it
          const covered = (above: boolean) =>
            inRange.some((o) => o !== n && o.tick < n.tick && o.tick + o.durTicks > n.tick + 1 && (above ? o.pitch > n.pitch : o.pitch < n.pitch) && q(o.durTicks) >= cfg.minDurQ);
          if ('top' in tc.split) voice = i === group.length - 1 && !covered(true) ? tc.split.top : tc.split.rest;
          else voice = i === 0 && !covered(false) ? tc.split.bottom : tc.split.rest;
        }
        const t = q(n.tick) - cfg.startQ;
        const d = Math.min(q(n.durTicks), cfg.endQ - q(n.tick));
        notes.push({ t: round(t), d: round(Math.max(0.05, d)), p: n.pitch + (tc.transpose ?? 0), v: round(Math.min(1, Math.max(0.3, n.velocity / 110)), 100), voice });
      });
    }
  }
  for (const n of cfg.addNotes ?? []) notes.push({ ...n });
  // de-duplicate identical onsets (unison doublings between parts)
  const seen = new Set<string>();
  const unique = notes
    .sort((a, b) => a.t - b.t || a.p - b.p)
    .filter((n) => {
      const key = `${n.t}:${n.p}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  // accent the downbeats a little so a dynamics-free MIDI still breathes
  const barQ = (cfg.meter[0] * 4) / cfg.meter[1];
  for (const n of unique) {
    const inBar = (((n.t - cfg.pickupQ) % barQ) + barQ) % barQ;
    if (inBar < 1e-3) n.v = round(Math.min(1, n.v + 0.1), 100);
  }
  const end = Math.max(...unique.map((n) => n.t + n.d));
  const arrangement = [...cfg.arrangement];
  if (dropped) arrangement.push(`${dropped} ornament/grace notes shorter than ${cfg.minDurQ} quarter notes removed.`);
  return {
    schema: 'musical-marbles/score@1',
    id: cfg.id,
    composer: cfg.composer,
    title: cfg.title,
    work: cfg.work,
    catalog: cfg.catalog,
    movement: cfg.movement,
    excerpt: cfg.excerpt,
    priority: cfg.priority,
    source: {
      collection: 'Mutopia Project',
      mutopiaId: cfg.mutopiaId,
      url: MUTOPIA(cfg.mutopiaId),
      file: `score-src/${cfg.file}`,
      edition: cfg.edition,
      license: cfg.license,
      note: cfg.licenseNote,
      excerptQuarterRange: [cfg.startQ, cfg.endQ],
    },
    arrangement,
    tempo: { bpm: cfg.bpm, beatUnit: 'quarter', rampTo: cfg.tempoRamp ?? 1 },
    meter: { numerator: cfg.meter[0], denominator: cfg.meter[1] },
    pickupBeats: cfg.pickupQ,
    durationBeats: round(end),
    phrases: cfg.phrases.map((p) => ({ t: p.q - cfg.startQ, label: p.label })),
    notes: unique,
  };
}

const outDir = join(root, 'public', 'scores');
mkdirSync(outDir, { recursive: true });
for (const cfg of pieces) {
  const data = build(cfg);
  // compact: one note per line keeps diffs and inspection readable
  const { notes, ...meta } = data;
  const json = JSON.stringify(meta, null, 2).replace(/\n}$/, `,\n  "notes": [\n${notes.map((n) => '    ' + JSON.stringify(n)).join(',\n')}\n  ]\n}\n`);
  writeFileSync(join(outDir, `${cfg.id}.json`), json);
  const counts: Record<string, number> = {};
  for (const n of notes) counts[n.voice] = (counts[n.voice] ?? 0) + 1;
  console.log(`${cfg.id}: ${notes.length} notes, ${data.durationBeats} beats, ~${((data.durationBeats * 60) / cfg.bpm).toFixed(1)} s at ${cfg.bpm} bpm`, counts);
}
