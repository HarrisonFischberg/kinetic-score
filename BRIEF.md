# Kinetic Score — original brief (condensed, all requirements kept)

Goal: Build and verify Kinetic Score: a polished browser-based audiovisual playground and video studio featuring interactive ball physics, repeatable geometric sound generators, a controllable Shepard-tone illusion, kinetic machines performing verified public-domain classical excerpts, and synchronized audiovisual recording. Implement it fully; no plans/mockups/placeholders. Decide without follow-up questions.

## Workflow
- Ralph /ralph-loop skipped (user choice). Bounded iterative loop, max 40 iterations, progress.md tracks completed work, actual test results, remaining work, blockers. Fix failures before expanding scope. No destructive cleanup. Commit meaningful progress; never secrets.
- Never output the completion promise unless every completion criterion is genuinely met and verified. Final response then exactly: <promise>COMPLETE</promise>

## Product
Two labeled modes: PLAYGROUND (free physics, generative music, experimentation) and PERFORMANCE (choreographed machines performing recognizable excerpts with reliable timing). Open browser -> attractive silent preview immediately; "Enable audio & start" button; no autoplay sound. Should feel like a game/musical toy.

## Tech
Three.js (orthographic camera, mostly 2D, shallow depth), TypeScript + Vite, Web Audio synthesis, MediaRecorder export, vanilla TS/CSS UI, optional light 2D physics lib. All client-side: no backend, accounts, keys, analytics, paid assets, mic/webcam, commercial audio, runtime remote downloads. Install deps, run build/typecheck/tests, fix errors. Suggested dirs: app/ simulation/ choreography/ music/ audio/ rendering/ recording/ presets/ ui/ settings/ tests/. Avoid needless abstraction.

## Visual
Premium neon arcade instrument: deep dark bg, crisp geometry, beautiful marbles, luminous tracks, restrained glow, time-based fading trails, brief collision flashes, tasteful particles, layered depth, compact readable controls. Desktop: large preview + collapsible panel. Mobile: responsive, touch-friendly, no accidental scroll on canvas. Avoid excessive bloom, huge dashboards, empty compositions.

## Playground / builder
Click/tap empty space drops ball; drag from spawn point to aim+launch; select/move/delete objects; place ramps, walls, bumpers, funnels, musical pads, note gates; tool palette; undo/redo; clear edit vs play modes; reset restores editable starting layout. Music element controls: pitch/scale degree, instrument, velocity sensitivity, retrigger behavior, optional chord, optional sequence advancement. Global: gravity, restitution, friction, ball radius, launch speed, spawn rate, ball cap, clear balls, reset scene. Drag vs launch vs drop unambiguous. Contact-entry events + cooldowns; no uncontrolled repeated sound.

## Generative scenes
A. Growing Ball: bounces in rect/circle arena; impacts grow radius, change pitch, advance sequence, morph timbre, pulse arena; safe growth limit + graceful completion/reset.
B. Collision Cascade: collisions spawn balls; distinguish wall vs ball-ball spawning; cooldowns, generation limits, overlap-free spawn, population + voice caps, recycling. Controlled evolving texture, not explosion.
C. Geometric Sequencer: rotating circles/polygons, pendulums, linked rods/gears, Lissajous paths; geometry drives events (crossing visible line, entering region, completing rotation, pendulum endpoint, path intersection). Controls: period, phase, frequency ratios, note mapping, scale, instrument, quantization. Easy short repeatable loop. Distinguish repeating sequencer loops / deterministic scene resets / seamless AV loops (only label seamless if visual+audio boundary state match).

## Shepard-Tone Lab
Genuine Shepard illusion: multiple octave-spaced voices, smooth frequency motion, bell-shaped amplitude window over log frequency, smooth octave recycling, safe gain normalization. Controls: rising/falling, rate, pitch range, layer count, brightness, master level, continuous vs collision-stepped. Visibly connected to simulation (impacts advance pitch phase or geometry drives it). Visualization of layers/phase. Standalone demo preset. No clicks/level jumps/wrap artifacts. Don't claim perception verified unless auditioned; test octave spacing, envelope, phase continuity programmatically.

## Classical library
Targets: Pachelbel Canon in D; Beethoven Für Elise; Mozart Rondo alla turca K.331; Bach Prelude C major BWV 846; Beethoven Ode to Joy (Sym. 9); Grieg Hall of the Mountain King. Expansion: Brandenburg excerpt, Four Seasons excerpt, Eine kleine Nachtmusik mvt 1, Moonlight mvt 1. Identify exact work/movement. 30-90 s recognizable excerpts, melody+rhythm+phrasing, accompaniment where feasible; no vague arpeggio substitutes. Rights: verified PD sources, original simplified arrangements, browser synthesis; no commercial recordings / unverified MIDI / modern copyrighted arrangements; don't invent sources; no worldwide-clearance promises. Unverifiable pieces disabled, not faked. Priority: Canon, Für Elise, Ode to Joy. Local inspectable score data: id, composer, title, source+rights notes, tempo, meter, beat, duration, MIDI pitch, velocity, voice/instrument, phrase markers. Music Sources/About panel. Optional later: import validated note-event JSON (user responsible for rights; never execute code). MIDI import optional.

## Machine must visibly play
Every composed note = visible activation (ball hits tuned pad, hammer strikes bell, pluck, paddle hits chime, ball crosses note gate, linked mechanism triggers chord). Rests = travel/holding cups/gates. Contacts classified musical / quiet mechanical / silent structural. No stray notes from incidental wall hits. Polyphony via multiple balls / parallel tracks / linked mechanisms. Consistent colors for melody, bass, accompaniment.

## Timing
PERFORMANCE: deterministic choreography around the score (timed releases, guided rails, holding chambers, controlled launch speeds, kinematic segments, constrained trajectories). Be transparent it's hybrid choreographed motion. Score-to-scene adapter: group simultaneous notes, allocate balls/mechanisms, select paths, schedule releases+arrivals, validate timing/reachability, no teleport or last-second snapping. One transport for music, scene, activations, camera, recording. Web Audio clock + short lookahead scheduler; render from same transport origin + pause accounting; compatible clock when audio disabled. Tempo changes preserve pitch + sync (apply on restart if needed).
SANDBOX: real contacts trigger notes; labeled generative/interpretive.

## Classical scene families
A. Canon Contraption (Canon in D): spectacular vertical Rube Goldberg, >=6 genuinely different mechanisms (hopper/release gate, chime stairs, tuned pegboard, seesaw releasing a ball, paddle wheel, funnel, guided spiral, bell tower, pendulum hammer, branching accompaniment lane, final bowl). Main ball starts melody, mechanisms release more balls, parallel paths do accompaniment, final cascade. Authored modular machine.
B. Melody Rain (Für Elise): timed falling balls hit tuned platforms; melody/accompaniment lanes; simultaneous drops for chords; recycle balls.
C. Musical Maze (Turkish March): balls traverse glowing maze; gates/tuned surfaces play notes; timed gates, designed routes; no deadlocks or stray notes.
D. Orbital Classics (Bach Prelude C): balls in circular arena; deflectors/guided arcs/note gates for reliable timing; growing-on-impact as separate sandbox option.
E. Ring Escape (Hall of the Mountain King): balls pass through rotating rings with real gaps matching collision geometry; choreographed progression; energy rises within safe limits.
Ode to Joy = cross-scene test piece. Allow song changes where adapter supports; disable unsupported combos with a reason.

## Physics / cameras / determinism
Fixed timestep, accumulator + catch-up cap, swept tests or bounded substeps, proper normals, penetration correction, contact-entry detection, safe spawning, world coords independent of resolution, seeded RNG, bounded balls/speed/particles/trails. Reset restores layout, balls, mechanisms, gates/rings, seed, transport, audio, camera, counters. Background tabs: no giant jumps; pause interrupted performances. Cameras: overview, smooth follow, manual pan/zoom, reset, portrait-friendly, anticipatory framing, no abrupt cuts. Readable during polyphony.

## Audio
One AudioContext. Voices: bell, glass chime, marimba pluck, warm sine pluck, soft arcade tone, sustained voice. User-gesture activation, master mute/volume, per-voice volume, envelopes, voice limiting, gain staging, compression/peak protection, optional subtle ambience, quiet optional mechanical fx. Route voices -> buses -> master -> speakers + recording destination. Reset/stop cancels future notes, kills voices safely. Pause/resume never duplicates/reorders events.

## UI
Scene, song, Performance/Sandbox, play/pause, restart, single-step when paused, tempo/sim speed, seed, safe randomize, audio, record, screenshot, clean view. Appearance: palettes, background, glow, trails, particles, note labels, trigger highlights, optional title/counters. Show only relevant controls; explain immediate vs restart-required. Persistence: save/load settings + layouts, versioned validated JSON schema, copy/paste with fallback textarea, safe localStorage, helpful errors, no executable imports. Shortcuts: Space play/pause, R restart, H controls, Esc leave clean view; not while typing. Labels, keyboard a11y, contrast, touch.

## Export
Portrait 720x1280/1080x1920, square 720x720/1080x1080, landscape 1280x720/1920x1080. Separate preview CSS size, renderer resolution, DPR; export exact dims. 30/60 fps when supported; manual, timed, record-performance-from-reset, optional countdown, auto-stop after final note + decay tail; PNG screenshot. Capture composited canvas (glow, particles, trails, camera, overlays rendered into canvas) + generated audio from graph; never DOM, mic, webcam. Runtime MediaRecorder MIME detection, extension matches format, no MP4 promise if only WebM. Show status, elapsed, stop, playable result, download, useful filename. Lock invalidating settings during take; restore after. Clean up streams/object URLs without breaking current download. Don't call real-time recording frame-perfect. Unsupported -> clear message, app still usable.

## Resources
Reuse geometry/materials, pool balls/particles/voices, no per-frame geometry rebuild, bounded allocations, dispose GPU/audio, remove listeners, cap preview DPR, resize targets correctly, time-based trails, stable on ordinary laptop.

## Order
1 shell+physics+audio activation; 2 drop/launch with musical collisions; 3 growing/cascade + geometric sequencer; 4 Shepard lab; 5 recording with audio; 6 verified score data + shared transport; 7 Canon Contraption; 8 remaining scene families; 9 extra songs; 10 builder polish, persistence, randomize, tests, docs. Don't silently downgrade; document omissions.

## Tests / acceptance
Automate: score validation, event ordering/grouping, seed reproducibility, transport pause/resume, reset cancellation, contact retrigger, spawn caps, settings validation, choreography timing/reachability, Shepard octave spacing + envelope continuity. Browser-verify where possible: loads w/o errors, drop/launch/edit work, collisions drive sound, bounded growth/spawn, repeatable sequencer, Shepard controllable, excerpts recognizable, notes match visible activations, sync holds, sandbox labeled, maze no deadlock, ring gaps match collision, camera readable, audio only after user action, reset/pause no stale notes, video dims correct, recording has audio, MIME/extension match, repeated recording works, saved projects reload, build/typecheck pass. Don't claim unperformed aural/visual verification. Maintain README.md (install, run, controls, architecture, sound, recording, rights/sources, limitations), progress.md, manual verification checklist.

## Completion gate
All of: runs w/o major errors; drop/launch + editing; growing+cascading controlled; repeatable geometric sequencer; controllable Shepard; flagship Rube Goldberg works; all five classical scene families; >=3 priority pieces with verified sources; remaining songs implemented-verified or documented unavailable; AV sync; video export with canvas+audio; persistence; build/tests pass; docs complete; no placeholder features; required browser behaviors verified. Otherwise report progress/blockers honestly, no promise. Before completion: delivery report (what built, how to run, scenes/songs, recording, tests performed, nonblocking limitations).
