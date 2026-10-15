import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerAll } from './helpers.ts';
import { timeNotes } from '../src/music/score.ts';
import { validateChoreography } from '../src/choreography/core.ts';
import { Rng } from '../src/core/rng.ts';
import { VOICINGS, type Family } from '../src/scenes/performance/perfScene.ts';
import { FAMILIES } from '../src/scenes/performance/families.ts';

const scores = registerAll();

function buildFor(f: Family, id: string, tempo = 1) {
  const score = scores.find((s) => s.id === id)!;
  const notes = timeNotes(score, tempo, f.leadIn);
  const ch = f.build(notes, { voicing: VOICINGS.classic.v, rng: new Rng(7), leadIn: f.leadIn, score, tempo });
  return { notes, ch };
}

for (const f of FAMILIES) {
  const supported = scores.filter((s) => f.supports(s) === null);
  test(`${f.id}: supports its default song and at least the Ode to Joy test piece`, () => {
    assert.ok(supported.some((s) => s.id === f.defaultSong), 'default song supported');
    assert.ok(supported.some((s) => s.id === 'ode-to-joy'), 'Ode to Joy supported');
  });
  for (const s of supported) {
    for (const tempo of [1, 0.8]) {
      test(`${f.id} × ${s.id} @${tempo}: every note is one visible activation, no teleports, contacts on time`, () => {
        const { notes, ch } = buildFor(f, s.id, tempo);
        // 1:1 mapping between score notes and sounding activation notes
        const want = notes.map((n) => `${n.time.toFixed(4)}:${n.pitch}`).sort();
        const got = ch.acts.flatMap((a) => a.notes.map((n) => `${a.time.toFixed(4)}:${n.pitch}`)).sort();
        assert.deepEqual(got, want);
        // every activation has a visible target prop
        const ids = new Set(ch.props.map((p) => p.id));
        for (const a of ch.acts) assert.ok(ids.has(a.target), `missing prop ${a.target}`);
        const rep = validateChoreography(ch.balls, ch.acts, { maxSpeed: ch.maxSpeed, contactTol: ch.contactTol });
        assert.deepEqual(rep.problems.slice(0, 5), [], `maxSpeed=${rep.maxSpeed.toFixed(1)}`);
        assert.deepEqual((ch.problems ?? []).slice(0, 5), [], 'builder plausibility problems');
        assert.ok(ch.duration >= notes[notes.length - 1].time);
      });
    }
  }
}

test('maze: every timed door is open whenever a marble is at it', async () => {
  const { mazeFamily } = await import('../src/scenes/performance/maze.ts');
  const { sampleActor } = await import('../src/choreography/core.ts');
  for (const id of ['rondo-alla-turca', 'ode-to-joy']) {
    const score = scores.find((s) => s.id === id)!;
    const notes = timeNotes(score, 1, mazeFamily.leadIn);
    const ch = mazeFamily.build(notes, { voicing: VOICINGS.classic.v, rng: new Rng(3), leadIn: mazeFamily.leadIn, score, tempo: 1 }) as ReturnType<typeof mazeFamily.build> & { doors: { ax: number; ay: number; bx: number; by: number; windows: [number, number][] }[] };
    assert.ok(ch.doors.length > 0, 'maze has doors');
    const s = { x: 0, y: 0, visible: false, alpha: 1, scale: 1 };
    let checked = 0;
    for (const b of ch.balls) {
      const t0 = b.segs[0].t0;
      const t1 = b.segs[b.segs.length - 1].t1;
      for (let t = t0; t <= t1; t += 1 / 200) {
        sampleActor(b, t, s);
        for (const d of ch.doors) {
          const mx = (d.ax + d.bx) / 2;
          const my = (d.ay + d.by) / 2;
          if (Math.hypot(s.x - mx, s.y - my) < b.r + 0.12) {
            checked++;
            assert.ok(d.windows.some(([w0, w1]) => t >= w0 && t <= w1), `${id}: door at (${mx.toFixed(2)},${my.toFixed(2)}) closed when ${b.id} passes at ${t.toFixed(3)}`);
          }
        }
      }
    }
    assert.ok(checked > 0, 'marbles actually pass through doors');
  }
});
