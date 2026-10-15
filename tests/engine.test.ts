import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, worldHash, FIXED_DT } from '../src/simulation/physics.ts';
import { Stepper } from '../src/simulation/stepper.ts';
import { Rng } from '../src/core/rng.ts';
import { EventScheduler, Transport } from '../src/transport/transport.ts';
import { ShepardPhase, shepardLayers, defaultShepard, WORKLET_SOURCE } from '../src/audio/shepard.ts';
import { sanitizeSettings, validateProject, defaultSettings } from '../src/settings/settings.ts';
import { validateLayout } from '../src/scenes/builder/layout.ts';
import { BUILDER_PRESETS } from '../src/scenes/builder/presets.ts';
import { loopMultiple } from '../src/scenes/generative/sequencer.ts';
import { parseMidi } from '../src/music/midi.ts';

function scenario(seed: number): World {
  const w = new World({ gravityY: -9.8 });
  w.addCollider({ type: 'segment', ax: -6, ay: -4, bx: 6, by: -5, thickness: 0.1 });
  w.addCollider({ type: 'circle', x: 0, y: 0, r: 0.8 }, { kick: 1.5 });
  w.addCollider({ type: 'arc', x: 0, y: 0, radius: 8, thickness: 0.1, start: 0, sweep: Math.PI * 2 });
  const rng = new Rng(seed);
  for (let i = 0; i < 25; i++) w.addBall(rng.range(-5, 5), rng.range(1, 6), 0.2, rng.range(-3, 3), 0);
  return w;
}

test('physics: same seed and inputs give bit-identical state', () => {
  const a = scenario(42);
  const b = scenario(42);
  for (let i = 0; i < 600; i++) {
    a.step();
    b.step();
  }
  assert.equal(worldHash(a), worldHash(b));
  const c = scenario(43);
  for (let i = 0; i < 600; i++) c.step();
  assert.notEqual(worldHash(a), worldHash(c));
});

test('physics: balls stay inside a closed arena (no tunnelling at high speed)', () => {
  const w = new World({ gravityY: 0, restitution: 1, damping: 0, maxSpeed: 40 });
  w.addCollider({ type: 'arc', x: 0, y: 0, radius: 5, thickness: 0.05, start: 0, sweep: Math.PI * 2 });
  for (let i = 0; i < 10; i++) w.addBall(0, 0, 0.15, 39 * Math.cos(i), 39 * Math.sin(i));
  for (let i = 0; i < 2400; i++) {
    w.step();
    for (const b of w.balls) assert.ok(Math.hypot(b.x, b.y) < 5, `escaped at step ${i}`);
  }
  assert.equal(w.balls.length, 10);
});

test('physics: contact entry fires once for a resting ball (no retrigger chatter)', () => {
  const w = new World({ gravityY: -9.8, restitution: 0.3 });
  const floor = w.addCollider({ type: 'segment', ax: -5, ay: 0, bx: 5, by: 0, thickness: 0.05 });
  w.addBall(0, 1, 0.2, 0, 0);
  let hits = 0;
  for (let i = 0; i < 1200; i++) {
    w.step();
    hits += w.events.filter((e) => e.collider === floor).length;
    w.events.length = 0;
  }
  // a few diminishing bounces, then it rests silently
  assert.ok(hits >= 1 && hits <= 6, `hits=${hits}`);
  const b = w.balls[0];
  assert.ok(Math.abs(b.y - 0.25) < 0.02, `rests on the floor (y=${b.y})`);
});

test('physics: sensors report crossings without deflecting', () => {
  const w = new World({ gravityY: 0, damping: 0 });
  const gate = w.addCollider({ type: 'segment', ax: 0, ay: -1, bx: 0, by: 1, thickness: 0.02 }, { sensor: true });
  const b = w.addBall(-1, 0, 0.1, 5, 0);
  let n = 0;
  for (let i = 0; i < 120; i++) {
    w.step();
    n += w.events.filter((e) => e.collider === gate).length;
    w.events.length = 0;
  }
  assert.equal(n, 1);
  assert.ok(Math.abs(b.vx - 5) < 1e-9 && b.x > 1);
});

test('stepper caps catch-up after a long stall', () => {
  const s = new Stepper(FIXED_DT, 10);
  assert.equal(s.advance(5), 10);
  assert.ok(s.droppedTime > 4.8);
  assert.equal(s.advance(FIXED_DT * 2.5), 2);
});

test('safe spawning: isFree rejects overlaps', () => {
  const w = new World();
  w.addBall(0, 0, 0.5);
  w.addCollider({ type: 'segment', ax: -5, ay: -2, bx: 5, by: -2, thickness: 0.1 });
  assert.equal(w.isFree(0.6, 0, 0.2), false);
  assert.equal(w.isFree(2, 0, 0.2), true);
  assert.equal(w.isFree(2, -1.75, 0.2), false);
});

class FakeClock {
  t = 100;
  now = () => this.t;
}

test('transport: pause/resume never drifts, seek and rate are exact', () => {
  const c = new FakeClock();
  const tr = new Transport(c.now);
  tr.play();
  c.t += 2;
  assert.equal(tr.position, 2);
  tr.pause();
  c.t += 5;
  assert.equal(tr.position, 2);
  tr.play();
  c.t += 1.5;
  assert.equal(tr.position, 3.5);
  tr.seek(10);
  c.t += 1;
  assert.equal(tr.position, 11);
  tr.setRate(2);
  c.t += 1;
  assert.equal(tr.position, 13);
  assert.equal(tr.clockAt(15), c.t + 1);
  // switching clock sources keeps the position
  const other = new FakeClock();
  other.t = 5;
  tr.setClock(other.now);
  assert.equal(tr.position, 13);
});

test('scheduler: pause cancels unstarted events and resume neither duplicates nor reorders', () => {
  const c = new FakeClock();
  const tr = new Transport(c.now);
  const events = Array.from({ length: 40 }, (_, i) => ({ time: i * 0.25, id: i }));
  const played: { id: number; when: number; cancelled: boolean }[] = [];
  const sched = new EventScheduler(events, (e, when) => {
    const rec = { id: e.id, when, cancelled: false };
    played.push(rec);
    return [{ cancel: () => (rec.cancelled = true) }];
  }, 0.3);
  tr.play();
  for (let k = 0; k < 20; k++) {
    sched.tick(tr);
    c.t += 0.1;
  }
  // pause at 1.95 s: the event at 2.0 s is already scheduled inside the lookahead window
  c.t -= 0.05;
  sched.pause(c.t, tr.position);
  tr.pause();
  c.t += 3;
  tr.play();
  sched.resume(tr.position, c.t);
  for (let k = 0; k < 120; k++) {
    sched.tick(tr);
    c.t += 0.1;
  }
  const sounding = played.filter((p) => !p.cancelled);
  assert.deepEqual(sounding.map((p) => p.id), events.map((e) => e.id), 'each event sounds exactly once, in order');
  for (let i = 1; i < sounding.length; i++) assert.ok(sounding[i].when >= sounding[i - 1].when);
  assert.ok(played.some((p) => p.cancelled), 'something was actually cancelled at pause');
});

test('scheduler: reset cancels everything pending', () => {
  const c = new FakeClock();
  const tr = new Transport(c.now);
  let cancelled = 0;
  const sched = new EventScheduler([{ time: 0.05 }, { time: 0.1 }, { time: 0.2 }], () => [{ cancel: () => cancelled++ }], 0.5);
  tr.play();
  sched.tick(tr);
  sched.reset();
  assert.equal(cancelled, 3);
});

test('shepard: octave spacing, zero-at-edges window, constant total level', () => {
  for (const n of [3, 5, 7, 10]) {
    for (let k = 0; k < 50; k++) {
      const phase = k / 50;
      const ls = shepardLayers(phase, n, 27.5);
      const sorted = [...ls].sort((a, b) => a.freq - b.freq);
      for (let i = 1; i < sorted.length; i++) assert.ok(Math.abs(sorted[i].freq / sorted[i - 1].freq - 2) < 1e-9, 'octave spaced');
      const total = ls.reduce((s, l) => s + l.amp, 0);
      assert.ok(Math.abs(total - 1) < 1e-9, `normalised level n=${n} total=${total}`);
    }
  }
  // the layer that wraps from top to bottom is silent at the wrap
  const before = shepardLayers(0.99999, 7, 27.5);
  const after = shepardLayers(0.00001, 7, 27.5);
  const top = before.reduce((a, b) => (b.freq > a.freq ? b : a));
  const bottom = after.reduce((a, b) => (b.freq < a.freq ? b : a));
  assert.ok(top.amp < 1e-6 && bottom.amp < 1e-6);
});

test('shepard: each layer glides continuously; only a silent layer ever jumps (no octave "zip")', () => {
  for (const n of [3, 7, 10]) {
    let prev = shepardLayers(0, n, 41.2).map((l) => ({ ...l }));
    for (let k = 1; k <= 4000; k++) {
      const cur = shepardLayers(k * 0.001, n, 41.2); // 4 octaves of rise, crossing several phase wraps
      cur.forEach((l, i) => {
        const ratio = l.freq / prev[i].freq;
        if (Math.abs(ratio - 1) > 0.01) assert.ok(prev[i].amp < 1e-4 && l.amp < 1e-4, `layer ${i} jumped ×${ratio.toFixed(3)} while audible (n=${n})`);
      });
      prev = cur.map((l) => ({ ...l }));
    }
  }
});

test('shepard worklet: per-sample synthesis never changes an audible layer\'s pitch abruptly', () => {
  // load the processor source with a minimal AudioWorkletGlobalScope stand-in
  let Proc: any;
  const scope = { sampleRate: 48000, currentTime: 0 };
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'globalThis_', WORKLET_SOURCE.replace(/currentTime/g, 'globalThis_.currentTime'))(
    class { port = { onmessage: null as unknown } },
    (_: string, c: unknown) => (Proc = c),
    scope.sampleRate,
    scope,
  );
  const p = new Proc();
  const sr = scope.sampleRate;
  const block = 128;
  const out = [new Float32Array(block)];
  let total = 0;
  const rate = 6 / 12; // octaves per second (fast, to cross several wraps)
  let prevTheta: number[] | null = null;
  let prevCur = 0;
  let maxAbs = 0;
  const frames = Math.round(5 * 60);
  for (let f = 0; f < frames; f++) {
    p.port.onmessage({ data: { total, rate, time: scope.currentTime, n: 7, fMin: 41.2, brightness: 0.35 } });
    // ~one animation frame of audio, in 128-sample blocks, checking each layer's frequency per block
    for (let b = 0; b < Math.round(sr / 60 / block); b++) {
      p.process([], [out]);
      scope.currentTime += block / sr;
      const theta = Array.from(p.theta as Float64Array);
      for (const v of out[0]) maxAbs = Math.max(maxAbs, Math.abs(v));
      if (prevTheta) {
        for (let i = 0; i < 7; i++) {
          // last-sample frequency of layer i vs the expected position from the glide state
          const pos = (((i + p.cur) % 7) + 7) % 7;
          const posPrev = (((i + prevCur) % 7) + 7) % 7;
          const amp = 0.5 - 0.5 * Math.cos((2 * Math.PI * pos) / 7);
          const jump = Math.abs(pos - posPrev);
          if (jump > 0.05) assert.ok(amp < 0.01, `layer ${i} moved ${jump.toFixed(2)} octaves in one block while audible (amp ${amp.toFixed(3)})`);
        }
      }
      prevTheta = theta;
      prevCur = p.cur;
    }
    total += rate / 60;
  }
  // the glide tracked the visual phase (within a few frames of lag) and produced sound
  assert.ok(Math.abs(p.cur - total) % 1 < 0.05 || Math.abs(p.cur - total) % 1 > 0.95, `cur ${p.cur} vs ${total}`);
  assert.ok(maxAbs > 0.05 && maxAbs <= 1.0001, `output peak ${maxAbs}`);
});

test('shepard: phase is continuous in both modes (no jumps)', () => {
  const s = defaultShepard();
  const p = new ShepardPhase();
  let prev = p.total;
  for (let i = 0; i < 2000; i++) {
    p.advance(1 / 120, s);
    assert.ok(Math.abs(p.total - prev) < 0.01);
    prev = p.total;
  }
  s.mode = 'stepped';
  for (let i = 0; i < 400; i++) {
    if (i % 60 === 0) p.step(s);
    p.advance(1 / 120, s);
    assert.ok(Math.abs(p.total - prev) < 0.015, 'stepped glide is smooth');
    prev = p.total;
  }
});

test('settings: defaults validate; hostile or broken input is rejected or sanitised', () => {
  const d = defaultSettings();
  assert.deepEqual(sanitizeSettings(JSON.parse(JSON.stringify(d))).errors, []);
  assert.ok(sanitizeSettings('nope').errors.length);
  assert.ok(sanitizeSettings({ schema: 'other' }).errors.length);
  const bad = { ...d, seed: -5, appearance: { ...d.appearance, palette: 'nonexistent', glow: 99 }, audio: { ...d.audio, master: 7 }, sceneValues: { 'x y': { a: 1 }, ok: { k: 'v', n: Infinity } } };
  const r = sanitizeSettings(JSON.parse(JSON.stringify(bad)));
  assert.equal(r.errors.length, 0);
  assert.equal(r.settings.appearance.palette, d.appearance.palette);
  assert.equal(r.settings.appearance.glow, d.appearance.glow);
  assert.equal(r.settings.audio.master, d.audio.master);
  assert.equal(r.settings.seed, d.seed);
  assert.equal(r.settings.sceneValues['x y'], undefined);
  const proj = validateProject({ schema: 'kinetic-score/project@1', name: 'x', sceneId: 'canon', settings: d });
  assert.ok(proj.project);
  assert.ok(validateProject({ schema: 'kinetic-score/project@1', sceneId: '../etc', settings: d }).errors.length);
});

test('layouts: presets validate; malformed layouts are rejected', () => {
  for (const p of BUILDER_PRESETS) assert.deepEqual(validateLayout(p.make()), [], p.id);
  const l = BUILDER_PRESETS[0].make();
  assert.ok(validateLayout({ ...l, elements: [{ ...l.elements[0], kind: 'laser' }] }).length);
  assert.ok(validateLayout({ ...l, elements: [{ ...l.elements[0], x1: 1e9 }] }).length);
  assert.ok(validateLayout({ ...l, elements: [l.elements[0], l.elements[0]] }).some((e) => e.includes('unique')));
});

test('sequencer: loop length is the LCM of rational periods', () => {
  assert.deepEqual(loopMultiple([{ n: 1, d: 1 }, { n: 3, d: 2 }, { n: 2, d: 1 }]), { n: 6, d: 1 });
  assert.deepEqual(loopMultiple([{ n: 1, d: 2 }, { n: 1, d: 3 }]), { n: 1, d: 1 });
  assert.deepEqual(loopMultiple([{ n: 3, d: 4 }]), { n: 3, d: 4 });
});

test('midi parser rejects non-MIDI data and parses a minimal file', () => {
  assert.throws(() => parseMidi(new Uint8Array([1, 2, 3, 4])));
  const bytes = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 12, 0, 0x90, 60, 100, 96, 0x80, 60, 0, 0, 0xff, 0x2f, 0];
  const m = parseMidi(new Uint8Array(bytes));
  assert.equal(m.tracks[0].notes.length, 1);
  assert.deepEqual([m.tracks[0].notes[0].pitch, m.tracks[0].notes[0].durTicks], [60, 96]);
});

test('scheduler: pausing exactly on an event time does not replay it on resume', () => {
  const c = new FakeClock();
  const tr = new Transport(c.now);
  const events = Array.from({ length: 12 }, (_, i) => ({ time: i * 0.5, id: i }));
  const live: number[] = [];
  const sched = new EventScheduler(events, (e) => {
    live.push(e.id);
    return [{ cancel: () => live.splice(live.lastIndexOf(e.id), 1) }];
  }, 0.2);
  tr.play();
  for (let k = 0; k < 20; k++) {
    sched.tick(tr);
    c.t += 0.1;
  }
  sched.tick(tr); // position exactly 2.0: event 4 starts now
  sched.pause(c.t, tr.position);
  tr.pause();
  c.t += 1;
  tr.play();
  sched.resume(tr.position, c.t);
  for (let k = 0; k < 60; k++) {
    sched.tick(tr);
    c.t += 0.1;
  }
  assert.deepEqual(live, events.map((e) => e.id));
});
