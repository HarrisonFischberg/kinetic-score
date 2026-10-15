import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Harmonizer, chordAt, PROGRESSIONS } from '../src/music/harmony.ts';
import { Rng } from '../src/core/rng.ts';

const pc = (p: number) => ((p % 12) + 12) % 12;

test('chords follow the progression (D major pentatonic, I–V–vi–IV)', () => {
  const cfg = { root: 2, scale: 'majorPent', progression: 'bright', chordSeconds: 4 };
  assert.equal(chordAt(cfg, 0).name, 'D');
  assert.equal(chordAt(cfg, 4.1).name, 'A');
  assert.equal(chordAt(cfg, 8.1).name, 'Bm');
  assert.equal(chordAt(cfg, 12.1).name, 'G');
  assert.equal(chordAt(cfg, 16.1).name, 'D', 'progression loops');
  // pentatonic keeps its character: C♯ (the third of A) is not in D major pentatonic
  assert.deepEqual(chordAt(cfg, 4.1).pcs.sort(), [4, 9]);
});

test('minor scales use the minor progression', () => {
  assert.equal(chordAt({ root: 9, scale: 'minor', progression: 'bright', chordSeconds: 4 }, 0).name, 'Am');
  assert.equal(chordAt({ root: 9, scale: 'minor', progression: 'bright', chordSeconds: 4 }, 4.1).name, 'F');
});

test('every guided note is a chord tone in range, for random hits', () => {
  for (const mode of ['chords', 'melody'] as const) {
    for (const scale of ['majorPent', 'minorPent', 'major', 'dorian', 'wholeTone']) {
      for (const progression of Object.keys(PROGRESSIONS)) {
        const h = new Harmonizer({ mode, scale, progression, root: 5 });
        const rng = new Rng(7);
        let t = 0;
        for (let i = 0; i < 300; i++) {
          t += rng.next() * 0.2;
          const p = h.pitch(40 + Math.floor(rng.next() * 50), t);
          if (p === null) continue;
          assert.ok(p >= h.cfg.low && p <= h.cfg.high, `${p} in range`);
          assert.ok(h.chord(t).pcs.includes(pc(p)), `${p} is a chord tone (${mode} ${scale} ${progression})`);
        }
      }
    }
  }
});

test('melody mode: each hit moves a small step from the previous note', () => {
  const h = new Harmonizer({ mode: 'melody', maxLeap: 7 });
  const rng = new Rng(3);
  let t = 0;
  let prev: number | null = null;
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    t += 0.15 + rng.next() * 0.3;
    // wildly jumping requests (e.g. pads far apart)
    const p = h.pitch(36 + Math.floor(rng.next() * 60), t);
    if (p === null) continue;
    if (prev !== null) {
      assert.ok(Math.abs(p - prev) <= 7, `leap ${prev} → ${p}`);
      checked++;
    }
    prev = p;
  }
  assert.ok(checked > 300);
});

test('pile-ups are thinned: at most maxBurst notes start within the window, never the same pitch twice', () => {
  const h = new Harmonizer({ mode: 'chords', maxBurst: 3, window: 0.12 });
  const played: number[] = [];
  for (let i = 0; i < 10; i++) {
    const p = h.pitch(60 + i, 1 + i * 0.001);
    if (p !== null) played.push(p);
  }
  assert.ok(played.length <= 3);
  assert.equal(new Set(played).size, played.length);
  assert.ok(h.suppressed >= 7);
  // after the window, notes flow again
  assert.notEqual(h.pitch(64, 1.5), null);
});

test('off mode passes pitches through untouched', () => {
  const h = new Harmonizer({ mode: 'off' });
  for (let i = 0; i < 20; i++) assert.equal(h.pitch(50 + i, 1), 50 + i);
});

test('chord stacking stays on chord tones', () => {
  const h = new Harmonizer({ mode: 'chords', scale: 'major', root: 0 });
  const base = h.pitch(60, 0)!;
  assert.equal(base, 60);
  assert.equal(h.above(base, 1, 0), 64);
  assert.equal(h.above(base, 2, 0), 67);
});
