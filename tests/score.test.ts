import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScores, rawScore } from './helpers.ts';
import { beatToSeconds, groupSimultaneous, timeNotes, validateScore, scoreDurationSeconds } from '../src/music/score.ts';
import { SONG_IDS } from '../src/music/library.ts';

test('every bundled score validates and is 30–90 s at its default tempo', () => {
  const scores = loadScores();
  assert.equal(scores.length, SONG_IDS.length);
  for (const s of scores) {
    assert.deepEqual(validateScore(s), [], s.id);
    const secs = scoreDurationSeconds(s);
    assert.ok(secs >= 29 && secs <= 90, `${s.id} lasts ${secs.toFixed(1)} s`);
    assert.ok(s.source.license.length > 0 && s.source.edition.length > 0, `${s.id} has rights notes`);
    assert.ok(s.notes.some((n) => n.voice === 'melody'), `${s.id} has a melody`);
  }
});

test('the three priority pieces are present with sources', () => {
  const ids = loadScores().filter((s) => s.priority).map((s) => s.id).sort();
  assert.deepEqual(ids, ['canon-in-d', 'fur-elise', 'ode-to-joy']);
});

test('recognisable openings are intact (melody pitches)', () => {
  const mel = (id: string, n: number) => loadScores().find((s) => s.id === id)!.notes.filter((x) => x.voice === 'melody').slice(0, n).map((x) => x.p);
  // Für Elise: E5 D#5 E5 D#5 E5 B4 D5 C5 A4
  assert.deepEqual(mel('fur-elise', 9), [76, 75, 76, 75, 76, 71, 74, 72, 69]);
  // Ode to Joy (G major): B B C D D C B A
  assert.deepEqual(mel('ode-to-joy', 8), [71, 71, 72, 74, 74, 72, 71, 69]);
  // Canon in D, violin I entry: F#5 E5 D5 C#5 B4 A4 B4 C#5
  assert.deepEqual(mel('canon-in-d', 8), [78, 76, 74, 73, 71, 69, 71, 73]);
  // Rondo alla turca: B A G# A C
  assert.deepEqual(mel('rondo-alla-turca', 5), [71, 69, 68, 69, 72]);
});

test('validator rejects malformed or hostile input', () => {
  assert.ok(validateScore(null).length > 0);
  assert.ok(validateScore({ schema: 'x' }).length > 0);
  const s = rawScore('ode-to-joy') as { notes: unknown[] };
  const bad = { ...s, notes: [{ t: 1, d: 1, p: 200, v: 2, voice: 'drums' }] };
  const errs = validateScore(bad);
  assert.ok(errs.some((e) => e.includes('.p')));
  assert.ok(errs.some((e) => e.includes('.v')));
  assert.ok(errs.some((e) => e.includes('.voice')));
  const unsorted = { ...s, notes: [s.notes[5], s.notes[0]] };
  assert.ok(validateScore(unsorted).some((e) => e.includes('out of order')));
  const proto = JSON.parse('{"__proto__": {"polluted": true}, "schema": "musical-marbles/score@1"}');
  validateScore(proto);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('timing: ordering, grouping and tempo ramp', () => {
  const s = loadScores().find((x) => x.id === 'canon-in-d')!;
  const tn = timeNotes(s, 1, 2);
  for (let i = 1; i < tn.length; i++) assert.ok(tn[i].time >= tn[i - 1].time);
  assert.equal(tn[0].time, 2);
  const groups = groupSimultaneous(tn);
  assert.equal(groups.reduce((a, g) => a + g.notes.length, 0), tn.length);
  for (const g of groups) for (const n of g.notes) assert.ok(Math.abs(n.time - g.time) <= 0.012);
  // final chord: 4 simultaneous notes
  assert.equal(groups[groups.length - 1].notes.length, 4);
  // tempo scaling halves times
  assert.ok(Math.abs(timeNotes(s, 2, 0)[10].time * 2 - timeNotes(s, 1, 0)[10].time) < 1e-9);
  // accelerando: later beats are shorter
  const mk = loadScores().find((x) => x.id === 'mountain-king')!;
  const first = beatToSeconds(1, mk) - beatToSeconds(0, mk);
  const last = beatToSeconds(mk.durationBeats, mk) - beatToSeconds(mk.durationBeats - 1, mk);
  assert.ok(last < first * 0.8, `ramp ${first} -> ${last}`);
});
