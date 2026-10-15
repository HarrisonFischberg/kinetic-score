# Kinetic Score — progress

Bounded iterative loop (max 40 iterations; Ralph plugin skipped by user choice). Each entry lists what
was done and what was actually run/verified.

## Decisions
- Stack: TypeScript + Three.js (r186, vendored in `vendor/three`, MIT) + Web Audio + MediaRecorder.
  Vite is configured for normal local use (`npm run dev` / `npm run build`). The cloud build
  environment could not reach the npm registry (HTTP 403 from the egress policy), so a
  zero-dependency path is also provided and is what was verified here: `node scripts/build-static.ts`
  (tsc → native ES modules + import map) and `node scripts/serve.ts`.
- Tests use Node's built-in test runner on TypeScript directly (Node ≥ 22.18), no Vitest.
- Custom deterministic 2D physics (circles vs segments/circles/arcs, kinematic bodies, sensors).
- Performance scenes are choreographed: every motion is a pure function of transport time,
  solved backwards from the score (ballistic arcs, rails, timed releases). Activations are
  the single source for both audio events and visible strikes.
- Score sources: Mutopia Project MIDI files in `score-src/`, converted by `scripts/build-scores.ts`
  to validated JSON in `public/scores/` with source/licence/arrangement notes.

| Piece | Mutopia id | Source edition | Mutopia license |
|---|---|---|---|
| Beethoven, Für Elise WoO 59 | 931 | Breitkopf & Härtel, 1888 | Public Domain |
| Pachelbel, Canon per 3 Violini e Basso (Canon in D) | 2047 | IMSLP (1694 work) | CC BY 4.0 (attribution required) |
| Bach, WTC I Prelude 1 C major BWV 846 | 5 | Unknown | Public Domain |
| Mozart, Sonata K.331, 3rd mvt Rondo alla turca | 108 | IMSLP | Public Domain |
| Grieg, Peer Gynt Suite 1 Op.46 No.4, Hall of the Mountain King (piano) | 1888 | The University Society, 1918 | Public Domain |
| Beethoven, Ode to Joy (hymn setting of Sym. 9 theme) | 528 | Various | Public Domain |
| Mozart, Eine kleine Nachtmusik K.525 mvt 1 | 900 | IMSLP | Public Domain |
| Bach, Brandenburg Concerto No.1 BWV 1046 mvt 1 | 1136 | Rust 1871, BG vol. 19 | CC BY 3.0 |

- Not used: Moonlight Sonata (Mutopia 276, CC BY-SA 2.5) and Vivaldi Spring (Mutopia 301,
  CC BY-SA 3.0): listed in the app as unavailable with the reason.

## Iterations
- 0: project folder, source research, MIDI downloads.
- 1: scaffold (package/tsconfig/vite config, vendored three + types), MIDI parser, score builder,
  physics, audio engine, transport + scheduler, renderer, builder sandbox, app shell.
  Verified: typecheck; headless Chromium: loads with 0 console errors, no audio before click,
  click-drop, launcher drag, contact notes, edit+undo.
- 2: Growing Ball, Collision Cascade, Geometric Sequencer (timeline scene with exact loop),
  Shepard lab. Verified: each scene runs in headless Chromium without errors (screenshots reviewed).
- 3: choreography core, performance scene base, Melody Rain; first unit tests (scores, 1:1 note↔activation).
- 4: Canon Contraption (4 stages, 12 mechanism types, finale bowl) + reflection-validity constraints.
- 5: Musical Maze, Orbital Classics, Ring Escape; computed song support with reasons; runtime
  choreography validation. Tests: 78 pass (scores, every family × supported song × tempo 1 and 0.8).

- 6: engine tests (physics determinism/tunnelling/retrigger/sensors, transport, scheduler, Shepard,
  settings, layouts, MIDI) — found and fixed a real bug: an event exactly at the pause instant was
  replayed on resume (added `EventScheduler.resume`). Maze door-timing test. 95 tests pass.
- 7: full headless-browser suite (26 checks: audio gating, scheduled-vs-due activations, pause/restart,
  builder interactions, caps, Shepard direction, loop wrap, recording ×3 with audio/size/MIME checks,
  screenshot, clean view, persistence across reload, mobile layout, all scenes) — 26/26, 0 console
  errors. Follow-camera snap on start, aspect-aware stage framing, wrapping mobile header.
  README and docs/VERIFICATION.md written.

- 8: gap pass against the brief: wired the dead "guide paths" control (look-ahead dots), quiet
  mechanical sounds in performances, builder "use current layout as start", validated score-JSON
  import, Orbital Classics sandbox mode (free physics, growing on impact), restart guarded during
  takes. Found and fixed a real bug: loading a project discarded its scene values and crashed for
  Builder projects (new layout round-trip check).
- 9: objective AV checks on recorded files: decoded audio onsets vs score (≈1.4 ms median jitter),
  YIN pitch of the openings of Für Elise, Ode to Joy (melody soloed) and the Canon ground bass —
  all exact; video flash vs audio bounded by the headless frame rate. Browser suite 32/32.

- 10: overview framing reserves headroom for the title overlay; final full runs: 95/95 unit tests,
  32/32 headless browser checks, 0 console errors.

- 11: npm access enabled by the user. `npm install` (Vite 7.3.7, TypeScript 5.9.3, 0 vulnerabilities),
  `npm run typecheck` clean, `npm test` 95/95, `npm run build` (Vite) succeeded (745 kB JS / 208 kB
  gzip). Browser suite against `vite preview` of the Vite build: 31/32 in the full run, 0 console
  errors; the one failure was the Canon recorded-audio analysis (one outlier onset under load), which
  then passed 3/3 when re-run on its own. Vite config now strips the static-build placeholder.

Iterations used: 11 of 40.

## Song support per scene (computed by each family, also shown in the Song menu)
- Canon Contraption, Melody Rain, Musical Maze: all 8 excerpts.
- Orbital Classics: Prelude, Canon, Für Elise, Ode to Joy, Mountain King. Disabled (leaps too fast
  for the arena): Rondo alla turca, Eine kleine Nachtmusik, Brandenburg 1.
- Ring Escape: Mountain King, Canon, Für Elise, Ode to Joy, Prelude. Disabled: Eine kleine,
  Brandenburg (notes too close together), Rondo alla turca (one pass too tight).

## Remaining / not verifiable here
- Real-device checks listed in docs/VERIFICATION.md (hearing, recognisability, AV sync by eye,
  Shepard perception, Safari/Firefox recording, touch devices, frame rate on real GPUs).
- MIDI import in the app not offered (score-JSON import is implemented and validated).
- The Canon recorded-audio analysis is occasionally flaky inside the full headless run (CPU-starved
  software rendering); it passes when run alone.
