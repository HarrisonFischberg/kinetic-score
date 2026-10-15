// Prints a summary of a MIDI file: tracks, note counts, ranges, tempos, meters, first notes.
// Usage: node scripts/inspect-midi.ts <file.mid> [trackIndex] [maxNotes]
import { readFileSync } from 'node:fs';
import { parseMidi } from '../src/music/midi.ts';

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nn = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;

const [file, trackArg, maxArg] = process.argv.slice(2);
const midi = parseMidi(new Uint8Array(readFileSync(file)));
console.log(`format ${midi.format} ppq ${midi.ppq}`);
console.log('tempos', midi.tempos.slice(0, 12).map((t) => `${(t.tick / midi.ppq).toFixed(2)}q:${(60e6 / t.usPerQuarter).toFixed(1)}bpm`).join(' '), midi.tempos.length > 12 ? `(+${midi.tempos.length - 12})` : '');
console.log('timeSigs', midi.timeSigs.map((t) => `${(t.tick / midi.ppq).toFixed(2)}q:${t.numerator}/${t.denominator}`).join(' '));
midi.tracks.forEach((t, i) => {
  if (!t.notes.length) {
    console.log(`#${i} "${t.name}" (no notes)`);
    return;
  }
  const ps = t.notes.map((n) => n.pitch);
  const last = t.notes[t.notes.length - 1];
  console.log(`#${i} "${t.name}" prog ${t.program} notes ${t.notes.length} range ${nn(Math.min(...ps))}-${nn(Math.max(...ps))} quarters ${(t.notes[0].tick / midi.ppq).toFixed(2)}..${((last.tick + last.durTicks) / midi.ppq).toFixed(2)}`);
});
if (trackArg !== undefined) {
  const t = midi.tracks[Number(trackArg)];
  const max = Number(maxArg ?? 40);
  console.log(t.notes.slice(0, max).map((n) => `${(n.tick / midi.ppq).toFixed(2)}:${nn(n.pitch)}/${(n.durTicks / midi.ppq).toFixed(2)}`).join(' '));
}
