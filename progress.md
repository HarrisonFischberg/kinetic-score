# Kinetic Score — progress

## Decisions
- Stack: Vite + TypeScript + Three.js, Web Audio, MediaRecorder, Vitest. Custom deterministic 2D physics (circles vs segments) planned.
- Ralph /ralph-loop plugin: skipped by user choice. Bounded iterative workflow tracked in this file (max 40 iterations).
- Score sources: Mutopia Project MIDI files rendered from LilyPond typesettings of PD editions, stored in `score-src/`.
  Plan: parse with a local build script into inspectable JSON note events, then arrange excerpts.

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

- Not used: Moonlight Sonata (Mutopia id 276, CC BY-SA 2.5) and Vivaldi Spring (id 301, CC BY-SA 3.0) — share-alike; document as unavailable unless a PD typesetting is found.
- Note: Mutopia "Source" fields of "IMSLP"/"Unknown"/"Various" do not name an exact edition; README must say so honestly.

## Iterations
- 0: project folder, source research, MIDI downloads. No app code yet.

## Remaining
- Everything in the brief (see README once written).
