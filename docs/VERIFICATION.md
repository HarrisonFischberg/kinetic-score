# Verification

## Automated

### Unit tests — `npm test` (or `node --test "tests/**/*.test.ts"`)
95 tests, all passing at the time of writing. Coverage: score data and validation, timing,
choreography plausibility for every performance family × supported song × tempo (1.0, 0.8),
maze door timing, physics determinism/tunnelling/retrigger/sensors, stepper cap, safe spawning,
transport and scheduler (pause/resume/seek/reset, no duplicates or reordering), Shepard maths,
settings/project/layout validation, sequencer loop length, MIDI parsing.

### Headless browser — `node scripts/browser-check.ts`
Chromium via Playwright, software WebGL (SwiftShader), `--autoplay-policy=no-user-gesture-required`
and the default virtual audio device. Latest run: **32/32 passed, 0 console errors**.

| Check | Result (latest run) |
|---|---|
| Loads with a silent, animating preview and the start card; no AudioContext before the click | pass |
| AudioContext starts only after "Enable audio & start" | pass |
| Performance: audio events scheduled so far equal the activations that are due (Canon, t≈9 s) | pass (7 = 7) |
| Pause holds the transport still; R restarts from the top | pass |
| Builder: click drops a ball, launcher drag launches, contacts produce notes, edit-mode pad placement + Ctrl+Z | pass |
| Cascade: population never exceeds the cap (cap 12, aggressive spawning) | pass |
| Growing ball: size stays within the limit | pass |
| Shepard lab: direction control reverses the phase | pass |
| Sequencer: timeline wraps seamlessly at the end | pass |
| Recording: 3 s timed take → WebM, 720×1280, extension matches MIME, audio track decodes, preview size restored | pass |
| Recording: second take (square 720×720) | pass |
| Recording: "whole performance" take starts at 0 and auto-stops after the last note + tail | pass |
| **Recorded audio vs score** (Melody Rain, Für Elise, whole-performance take, decoded from the WebM): note onsets detected in the file match the score's activations | pass — 32/32 within ±30 ms; after removing the constant recorder offset, timing jitter median ≈1.3 ms, 95th percentile ≈3.5 ms |
| **Recorded audio pitches**: YIN pitch of the first eight notes in the file | pass — 76 75 76 75 76 71 74 72 = E5 D♯5 E5 D♯5 E5 B4 D5 C5 (Für Elise's opening, exact) |
| **Recorded video vs audio**: frame at which the E5 pad visibly flashes vs that note's onset in the same file | pass within frame resolution — skews of a few tens of ms either way (observed across runs: −34 … +63 ms); headless software rendering only produced ≈6–7 frames/s, so this is bounded by the frame interval (≈150 ms). On real GPUs at 30 fps the bound is ≈33 ms; not measured here |
| **Recorded audio, Ode to Joy** (melody's instrument soloed via the voice-volume mixer): melody onsets and pitches | pass — 11/11 onsets, jitter median ≈1.4 ms; first eight melody pitches 71 71 72 74 74 72 71 69 = B4 B4 C5 D5 D5 C5 B4 A4 (exact) |
| **Recorded audio, Canon Contraption**: onsets and the pitches of the unaccompanied ground bass | pass — 9/9 onsets, jitter median ≈1.4 ms; first eight pitches 50 45 47 42 43 38 43 45 = D3 A2 B2 F♯2 G2 D2 G2 A2 (exact) |
| PNG screenshot downloads | pass |
| Clean view hides chrome; Esc restores | pass |
| Persistence: saved project survives a reload and loads back (palette + scene) | pass |
| Persistence: an edited Builder layout round-trips through a saved project | pass |
| Score import: hostile JSON rejected; valid JSON becomes a playable song | pass |
| Orbital Classics sandbox mode: free physics plays the song's chimes; badge says interpretive | pass |
| Mobile portrait (390×844): no horizontal scroll, canvas visible, `touch-action: none` | pass |
| Every scene (10) renders without console errors | pass |

Screenshots from the run are written to `build/browser-check/` (not committed).

## Not verifiable in the build environment (manual checklist)

These need a real browser on real hardware. Tick them off when you try the app:

- [ ] **Hearing**: Enable audio; each of the six voices sounds clean (Sound → Test sound); no
      clipping or crackle with many notes (Collision Cascade at a high cap, Canon finale).
- [ ] **Recognisability by ear**: each excerpt is recognisable (Canon in D, Für Elise, Ode to Joy,
      Rondo alla turca, Prelude in C, Mountain King, Eine kleine Nachtmusik, Brandenburg 1).
      (The three priority pieces' openings were confirmed *by pitch analysis of recorded files*,
      not by listening.)
- [ ] **AV sync by eye and ear**: in Melody Rain and the Canon Contraption, every strike flashes
      exactly as its note sounds (try with headphones and with speakers).
- [ ] **Shepard illusion**: in the lab, the tone seems to rise forever without an audible
      jump at the wrap; falling works too; stepped mode advances one step per impact.
- [ ] **Pause/resume** mid-performance never repeats or skips notes audibly; Restart stops all
      sound immediately.
- [ ] **Background tab**: switching tabs during a performance pauses it; returning shows a notice.
- [ ] **Recording in Chrome/Edge, Firefox and Safari**: the file plays in a desktop player, has
      sound, the extension matches the format (Safari usually produces MP4), 1080p and 60 fps
      takes are usable, repeated takes work.
- [ ] **Touch**: on a phone, tap drops a ball, drag from the launcher launches, pinch zooms,
      the page does not scroll while interacting with the canvas.
- [ ] **Performance**: frame rate stays smooth on an ordinary laptop with trails/particles on.
- [ ] **Accessibility**: all controls reachable by keyboard; focus rings visible; shortcuts
      do not fire while typing in text fields.
