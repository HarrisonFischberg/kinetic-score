// Application shell: owns the renderer, the single AudioContext, the transport,
// the current scene, the UI chrome, recording and persistence.
import { AudioEngine } from '../audio/engine.ts';
import { INSTRUMENTS } from '../audio/instruments.ts';
import { ShepardEngine } from '../audio/shepard.ts';
import { clamp } from '../core/math.ts';
import { randomSeed, Rng } from '../core/rng.ts';
import { allScores, loadLibrary, registerScore, UNAVAILABLE } from '../music/library.ts';
import { validateScore, type ScoreData } from '../music/score.ts';
import { CameraController } from '../rendering/camera.ts';
import { Particles, Trails } from '../rendering/effects.ts';
import { getPalette, PALETTES } from '../rendering/palette.ts';
import { Renderer } from '../rendering/renderer.ts';
import { downloadBlob, Recorder, recordingSupport, type RecordingResult } from '../recording/recorder.ts';
import type { BuilderScene } from '../scenes/builder/builderScene.ts';
import type { ParamDef, ParamValue, PerfEvent, Scene, SceneServices } from '../scenes/types.ts';
import { defaultSettings, deleteProject, EXPORT_SIZES, listProjects, loadSettings, saveProject, saveSettings, storageAvailable, validateProject, type AppSettings, type Project } from '../settings/settings.ts';
import { EventScheduler, Transport, type Cancellable } from '../transport/transport.ts';
import { renderParams } from '../ui/controls.ts';
import { clear, fmtTime, h, isTypingTarget } from '../ui/dom.ts';
import { SCENES, sceneEntry, type SceneEntry } from './registry.ts';

type Mode = 'playground' | 'performance';

export class App {
  private root: HTMLElement;
  private renderer!: Renderer;
  private camera = new CameraController();
  readonly audio = new AudioEngine();
  private shepard = new ShepardEngine();
  private transport: Transport;
  private particles = new Particles();
  private trails = new Trails();
  private recorder = new Recorder();
  settings: AppSettings;
  private scene!: Scene;
  private entry!: SceneEntry;
  private scheduler: EventScheduler<PerfEvent> | null = null;
  private perfDuration = 0;
  private perfLoop = 0;
  private loopTake: { phase: 'preroll' | 'rolling'; start: number } | null = null;
  private finished = false;
  private silentPreview = true;
  private overlayEl: HTMLElement | null = null;
  private lastFrame = 0;
  private rafId = 0;
  private saveTimer = 0;
  private statsTimer = 0;
  private recordStopAt: number | null = null;
  private recordPerformance = false;
  private recordStartWall = 0;
  private countdownTimer = 0;
  private recordingSize: [number, number] | null = null;
  private pausedByVisibility = false;

  // DOM
  private stage!: HTMLElement;
  private frameBox!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private panel!: HTMLElement;
  private badge!: HTMLElement;
  private recStatus!: HTMLElement;
  private countdownEl!: HTMLElement;
  private cleanHint!: HTMLElement;
  private toastBox!: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private sceneControls!: HTMLElement;
  private statsEl!: HTMLElement;
  private songInfo!: HTMLElement;
  private exportResult!: HTMLElement;
  private recordNote!: HTMLElement;
  private projectList!: HTMLElement;
  private pointers = new Map<number, { x: number; y: number }>();
  private panDrag: { x: number; y: number } | null = null;
  private pinch: { d: number; cx: number; cy: number } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    const loaded = loadSettings();
    this.settings = loaded.settings;
    this.transport = new Transport(() => (this.audio.running ? this.audio.now() : performance.now() / 1000));
    for (const w of loaded.warnings) setTimeout(() => this.notify(w, 'warn'), 500);
  }

  async start(): Promise<void> {
    this.buildChrome();
    try {
      this.renderer = new Renderer(this.canvas);
    } catch (e) {
      this.fatal(`WebGL could not start (${e instanceof Error ? e.message : String(e)}). Kinetic Score needs a browser with WebGL 2 enabled.`);
      return;
    }
    const lib = await loadLibrary();
    for (const e of lib.errors) this.notify(e, 'warn');
    this.applyAudioSettings();
    this.applyAppearance();
    const first = sceneEntry(this.settings.lastScene) ?? SCENES[0];
    this.switchScene(first.id);
    this.buildOverlay();
    new ResizeObserver(() => this.layout()).observe(this.stage);
    this.layout();
    window.addEventListener('keydown', (e) => this.keydown(e));
    document.addEventListener('visibilitychange', () => this.visibility());
    window.addEventListener('beforeunload', () => {
      saveSettings(this.settings);
      this.recorder.dispose();
    });
    this.recorder.onDone = (r) => this.recordingDone(r);
    this.recorder.onError = (m) => {
      this.notify(m, 'warn');
      this.afterRecording();
    };
    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame((t) => this.frame(t));
    this.statsTimer = window.setInterval(() => this.updateStats(), 250);
  }

  private fatal(msg: string): void {
    clear(this.stage);
    this.stage.append(h('div', { class: 'overlay' }, h('div', { class: 'card' }, h('h1', {}, 'Kinetic Score'), h('p', {}, msg))));
  }

  // ------------------------------------------------------------------ chrome

  private buildChrome(): void {
    const r = this.root;
    clear(r);
    const modeSeg = h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': 'Mode' },
      h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => this.setMode('playground'), title: 'Free physics, generative music and experiments' }, 'Playground'),
      h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => this.setMode('performance'), title: 'Choreographed machines performing classical excerpts' }, 'Performance'),
    );
    const sceneSel = h('select', { 'aria-label': 'Scene', onchange: (e: Event) => this.switchScene((e.target as HTMLSelectElement).value) });
    const songSel = h('select', { 'aria-label': 'Song', class: 'song', onchange: (e: Event) => this.setSceneParam('song', (e.target as HTMLSelectElement).value) });
    const play = h('button', { class: 'hbtn icon primary', type: 'button', title: 'Play / pause (Space)', 'aria-label': 'Play or pause', onclick: () => this.togglePlay() }, '▶');
    const restart = h('button', { class: 'hbtn icon', type: 'button', title: 'Restart from the beginning (R)', 'aria-label': 'Restart', onclick: () => this.userRestart() }, '↺');
    const step = h('button', { class: 'hbtn icon hide-narrow', type: 'button', title: 'Single step while paused (.)', 'aria-label': 'Single step', onclick: () => this.stepOnce() }, '⏭');
    const time = h('span', { class: 'time hide-narrow', 'aria-live': 'off' }, '0:00.0');
    const speedSel = h(
      'select',
      { class: 'hide-narrow', 'aria-label': 'Simulation speed', title: 'Simulation speed (playground)', onchange: (e: Event) => this.setSimSpeed(Number((e.target as HTMLSelectElement).value)) },
      ...[0.25, 0.5, 1, 1.5, 2].map((v) => h('option', { value: String(v) }, `${v}×`)),
    );
    const audioBtn = h('button', { class: 'hbtn', type: 'button', title: 'Enable audio / mute speakers', onclick: () => this.audioButton() }, '🔇 Sound off');
    const rec = h('button', { class: 'hbtn rec', type: 'button', title: 'Record video (canvas + generated audio)', onclick: () => this.toggleRecord() }, '● Rec');
    const shot = h('button', { class: 'hbtn icon', type: 'button', title: 'Save a PNG screenshot', 'aria-label': 'Screenshot', onclick: () => this.screenshot() }, '📷');
    const cleanBtn = h('button', { class: 'hbtn icon', type: 'button', title: 'Clean view — hide all controls (Esc to leave)', 'aria-label': 'Clean view', onclick: () => this.setClean(true) }, '⛶');
    const panelBtn = h('button', { class: 'hbtn icon', type: 'button', title: 'Show / hide controls (H)', 'aria-label': 'Toggle controls panel', onclick: () => this.togglePanel() }, '☰');
    const header = h('header', {}, h('div', { class: 'brand' }, h('span', { class: 'dot' }), h('span', { class: 'hide-narrow' }, 'Kinetic Score')), modeSeg, sceneSel, songSel, play, restart, step, speedSel, time, h('div', { class: 'spacer' }), audioBtn, rec, shot, cleanBtn, panelBtn);
    this.els = { modeSeg, sceneSel, songSel, play, restart, step, time, speedSel, audioBtn, rec, shot };

    this.canvas = h('canvas', { tabindex: '0', 'aria-label': 'Kinetic Score stage. Click to interact; wheel to zoom; right-drag to pan.' });
    this.frameBox = h('div', { class: 'framebox' }, this.canvas);
    this.badge = h('div', { class: 'badge' });
    this.recStatus = h('div', { class: 'rec-status', role: 'status' }, h('span', { class: 'led' }), h('span', { class: 'rec-time' }, 'REC 0:00'), h('button', { class: 'btn', type: 'button', onclick: () => this.stopRecording() }, 'Stop'));
    this.countdownEl = h('div', { class: 'countdown', 'aria-live': 'assertive' });
    this.cleanHint = h('div', { class: 'clean-hint' }, 'Clean view — press Esc to show controls');
    this.stage = h('main', { class: 'stage' }, this.frameBox, this.badge, this.recStatus, this.countdownEl, this.cleanHint);
    this.panel = h('aside', { class: 'panel', 'aria-label': 'Controls' });
    this.toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    r.append(header, this.stage, this.panel, this.toastBox);
    this.attachPointer();
    (this.els.speedSel as HTMLSelectElement).value = String(this.settings.simSpeed);
  }

  private buildOverlay(): void {
    const supported = this.audio.supported;
    const enable = h('button', { class: 'btn primary', type: 'button', onclick: () => this.enableAudio(true) }, supported ? '🔊 Enable audio & start' : 'Start');
    const silent = h('button', { class: 'btn', type: 'button', onclick: () => this.dismissOverlay() }, 'Continue without sound');
    this.overlayEl = h(
      'div',
      { class: 'overlay' },
      h(
        'div',
        { class: 'card' },
        h('h1', {}, 'Kinetic Score'),
        h('p', {}, 'Marbles, machines and music. Build sound sculptures in the Playground, or watch kinetic contraptions perform public-domain classics in Performance mode. Nothing makes sound until you say so.'),
        h('div', { class: 'row' }, enable, supported ? silent : null),
        h('small', {}, supported ? 'Audio is synthesised live in your browser. Space play/pause · R restart · H controls' : 'Web Audio is not available in this browser — visuals only.'),
      ),
    );
    this.stage.append(this.overlayEl);
    enable.focus();
  }

  private dismissOverlay(): void {
    this.overlayEl?.remove();
    this.overlayEl = null;
    this.silentPreview = false;
  }

  async enableAudio(restart: boolean): Promise<void> {
    if (!this.audio.supported) {
      this.dismissOverlay();
      return;
    }
    try {
      await this.audio.start();
    } catch (e) {
      this.notify(`Audio could not start: ${e instanceof Error ? e.message : String(e)}`, 'warn');
      this.dismissOverlay();
      return;
    }
    this.transport.setClock(() => (this.audio.running ? this.audio.now() : performance.now() / 1000));
    this.applyAudioSettings();
    if (this.audio.ctx) this.shepard.attach(this.audio.ctx, this.audio.input);
    this.dismissOverlay();
    this.updateAudioButton();
    if (restart) this.restart();
    else if (this.scheduler) this.scheduler.seek(this.transport.position, this.transport.now());
  }

  private audioButton(): void {
    if (!this.audio.running) {
      void this.enableAudio(false);
      return;
    }
    this.settings.audio.muted = !this.settings.audio.muted;
    this.audio.setMuted(this.settings.audio.muted);
    this.updateAudioButton();
    this.persist();
    this.buildPanel();
  }

  private updateAudioButton(): void {
    const b = this.els.audioBtn;
    if (!this.audio.running) b.textContent = '🔇 Sound off';
    else if (this.settings.audio.muted) b.textContent = '🔈 Muted';
    else b.textContent = '🔊 Sound on';
    b.setAttribute('aria-label', b.textContent);
  }

  private setMode(mode: Mode): void {
    if (this.recorder.recording) return this.notify('Stop recording before switching scenes.', 'warn');
    const target = SCENES.find((s) => s.mode === mode);
    if (target && this.entry.mode !== mode) {
      const preferred = mode === 'performance' ? 'canon' : 'builder';
      this.switchScene(sceneEntry(preferred)?.mode === mode ? preferred : target.id);
    }
  }

  private refreshHeader(): void {
    const seg = this.els.modeSeg;
    const [pg, pf] = Array.from(seg.querySelectorAll('button'));
    pg.setAttribute('aria-pressed', String(this.entry.mode === 'playground'));
    pf.setAttribute('aria-pressed', String(this.entry.mode === 'performance'));
    pf.disabled = !SCENES.some((s) => s.mode === 'performance');
    const sel = this.els.sceneSel as HTMLSelectElement;
    clear(sel);
    for (const s of SCENES.filter((x) => x.mode === this.entry.mode)) sel.append(h('option', { value: s.id }, s.title));
    sel.value = this.entry.id;
    const songSel = this.els.songSel as HTMLSelectElement;
    const songDef = this.scene.params.find((p) => p.key === 'song');
    clear(songSel);
    if (songDef?.options) {
      for (const o of songDef.options) songSel.append(h('option', { value: o.value, disabled: !!o.disabled, title: o.disabled ?? '' }, o.label));
      songSel.value = String(this.scene.values.song);
      songSel.style.display = '';
    } else songSel.style.display = 'none';
    (this.els.speedSel as HTMLElement).style.display = this.entry.mode === 'playground' ? '' : 'none';
    this.badge.textContent = `${this.entry.mode === 'playground' ? 'Playground' : 'Performance'} · ${this.scene.info.motion}`;
    const locked = this.recorder.recording;
    sel.disabled = locked;
    songSel.disabled = locked;
    for (const b of Array.from(seg.querySelectorAll('button'))) (b as HTMLButtonElement).disabled = locked || (b === pf && !SCENES.some((s) => s.mode === 'performance'));
  }

  // ------------------------------------------------------------------ scenes

  private services(): SceneServices {
    return {
      audio: this.audio,
      shepard: this.shepard,
      camera: this.camera,
      particles: this.particles,
      trails: this.trails,
      palette: () => getPalette(this.settings.appearance.palette),
      appearance: () => this.settings.appearance,
      seed: () => this.settings.seed,
      notify: (m, k) => this.notify(m, k),
      refreshControls: () => this.renderSceneControls(),
      timelineChanged: () => this.rebuildTimeline(),
    };
  }

  switchScene(id: string): void {
    const entry = sceneEntry(id);
    if (!entry) return;
    if (this.recorder.recording) return this.notify('Stop recording before switching scenes.', 'warn');
    this.audio.stopAll();
    this.shepard.silence();
    this.scheduler?.cancelAll();
    this.scheduler = null;
    if (this.scene) {
      this.saveSceneValues();
      this.scene.dispose();
    }
    this.particles.clear();
    this.trails.clear();
    this.entry = entry;
    const scene = entry.make();
    // restore persisted values where keys and types still match
    const saved = this.settings.sceneValues[entry.id];
    if (saved) {
      for (const def of scene.params) {
        const v = saved[def.key];
        if (v === undefined || def.type === 'button' || def.key.startsWith('sel.')) continue;
        if (typeof v !== typeof scene.values[def.key]) continue;
        if (def.type === 'range' && typeof v === 'number' && (v < (def.min ?? -Infinity) || v > (def.max ?? Infinity))) continue;
        if (def.type === 'select' && !(def.options ?? []).some((o) => o.value === v && !o.disabled)) continue;
        scene.values[def.key] = v;
      }
    }
    this.scene = scene;
    scene.init(this.services());
    if (entry.id === 'builder' && this.settings.layout) {
      const errs = (scene as unknown as BuilderScene).setLayout(this.settings.layout, true);
      if (errs.length) this.notify(`Saved layout ignored: ${errs[0]}`, 'warn');
    }
    this.settings.lastScene = entry.id;
    this.camera.mode = 'overview';
    this.restart(true);
    this.camera.setBounds(scene.bounds(), true);
    if (scene.preferredCamera === 'follow') {
      this.camera.setMode('follow');
      this.camera.snapNext = true;
    }
    this.refreshHeader();
    this.buildPanel();
    this.persist();
  }

  private saveSceneValues(): void {
    const out: Record<string, ParamValue> = {};
    for (const def of this.scene.params) if (def.type !== 'button' && !def.key.startsWith('sel.')) out[def.key] = this.scene.values[def.key];
    this.settings.sceneValues[this.entry.id] = out;
    if (this.entry.id === 'builder') this.settings.layout = (this.scene as unknown as BuilderScene).getLayout();
  }

  private setSceneParam(key: string, value: ParamValue): void {
    const def = this.scene.params.find((p) => p.key === key);
    if (!def) return;
    if (this.isLocked(def)) return this.notify('This setting is locked while recording.', 'warn');
    if (def.type !== 'button') this.scene.values[key] = value;
    this.scene.onParam?.(key);
    if (key === 'song' || (key === 'mode' && this.entry.mode === 'performance')) {
      this.restart();
      this.refreshHeader();
      this.buildPanel();
    } else if (def.applies === 'restart' && this.entry.mode === 'performance') {
      this.notify(`${def.label}: applies on restart — press R`);
    }
    if (def.type !== 'button') {
      this.saveSceneValues();
      this.persist();
    }
  }

  private isLocked(def: ParamDef): boolean {
    return this.recorder.recording && (def.applies === 'restart' || def.key === 'song');
  }

  // ------------------------------------------------------------------ transport

  private togglePlay(): void {
    if (this.overlayEl) return void this.enableAudio(true);
    if (this.transport.playing) this.pause();
    else this.play();
  }

  private play(): void {
    if (this.finished) return this.restart();
    this.transport.play();
    if (this.scheduler) this.scheduler.resume(this.transport.position, this.transport.now());
    this.pausedByVisibility = false;
    this.updatePlayButton();
  }

  private pause(): void {
    if (this.scheduler) this.scheduler.pause(this.transport.now(), this.transport.position);
    this.transport.pause();
    if (this.scheduler) this.audio.cancelFuture();
    this.updatePlayButton();
  }

  private updatePlayButton(): void {
    const playing = this.transport.playing;
    this.scene?.setPlaying?.(playing);
    this.els.play.textContent = playing ? '❚❚' : '▶';
    this.els.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  restart(silentRebuild = false): void {
    this.scheduler?.reset();
    this.audio.stopAll();
    this.shepard.silence();
    this.particles.clear();
    this.trails.clear();
    this.scene.reset();
    this.finished = false;
    this.transport.stop();
    this.transport.seek(0);
    const perf = this.scene.performance?.() ?? null;
    if (perf) {
      this.perfDuration = perf.duration;
      this.perfLoop = perf.loop ?? 0;
      this.scheduler = new EventScheduler<PerfEvent>(perf.events, (e, when) => this.playEvent(e, when), 0.15);
    } else {
      this.scheduler = null;
      this.perfLoop = 0;
    }
    this.transport.setRate(this.timelineRate());
    this.transport.play();
    this.updatePlayButton();
    if (!silentRebuild) this.camera.setMode(this.camera.mode === 'manual' ? 'overview' : this.camera.mode);
    if (this.camera.mode === 'follow') this.camera.snapNext = true;
  }

  /** playground timelines follow the sim-speed control; song performances always run at 1× (tempo is a scene setting) */
  private timelineRate(): number {
    return this.entry.mode === 'playground' && this.scheduler ? this.settings.simSpeed : 1;
  }

  private rebuildTimeline(): void {
    const perf = this.scene.performance?.();
    if (!perf || !this.scheduler) return;
    this.perfDuration = perf.duration;
    this.perfLoop = perf.loop ?? 0;
    const pos = this.perfLoop ? this.transport.position % this.perfLoop : Math.min(this.transport.position, perf.duration);
    this.scheduler.setEvents(perf.events);
    this.transport.seek(pos);
    this.scheduler.seek(pos, this.transport.now());
    this.loopTake = null;
  }

  /** Restart requested by the user (button or R): not allowed in the middle of a take. */
  private userRestart(): void {
    if (this.recorder.recording || this.loopTake) return this.notify('Restart is disabled while recording — stop the take first.', 'warn');
    this.restart();
  }

  private playEvent(e: PerfEvent, when: number): Cancellable[] {
    if (!this.audio.running) return [];
    const out: Cancellable[] = [];
    if (e.mech) {
      const m = this.audio.mech(e.mech.kind, e.mech.vel, e.pan, when);
      if (m) out.push(m);
    }
    for (const n of e.notes) {
      const v = this.audio.play(n.inst, n.pitch, { vel: n.vel, when, dur: n.dur, pan: e.pan });
      if (v) out.push(v);
    }
    return out;
  }

  private stepOnce(): void {
    if (this.transport.playing) this.pause();
    if (this.entry.mode === 'playground') this.scene.update(1 / 60, this.transport.position);
    else {
      this.transport.seek(this.transport.position + 1 / 30);
      this.scheduler?.seek(this.transport.position, this.transport.now());
    }
  }

  private setSimSpeed(v: number): void {
    this.settings.simSpeed = clamp(v, 0.1, 4);
    if (this.scheduler && this.entry.mode === 'playground') {
      this.transport.setRate(this.timelineRate());
      this.scheduler.seek(this.transport.position, this.transport.now());
    }
    this.persist();
  }

  private visibility(): void {
    if (document.hidden) {
      if (this.entry.mode === 'performance' && this.transport.playing && !this.recorder.recording) {
        this.pause();
        this.pausedByVisibility = true;
      }
    } else if (this.pausedByVisibility) {
      this.notify('Performance paused while the tab was hidden — press Space to resume.');
    }
  }

  // ------------------------------------------------------------------ frame loop

  private frame(nowMs: number): void {
    this.rafId = requestAnimationFrame((t) => this.frame(t));
    const dt = clamp((nowMs - this.lastFrame) / 1000, 0, 0.1);
    this.lastFrame = nowMs;
    const scene = this.scene;
    if (!scene || !this.renderer) return;
    const dl = this.renderer.draw;
    const app = this.settings.appearance;
    let t = this.transport.position;
    if (this.scheduler) {
      this.scheduler.tick(this.transport);
      if (this.transport.playing && this.perfLoop && t >= this.perfDuration) {
        // exact periodic timeline: wrapping by whole loops is seamless
        const wrapped = t - Math.floor(t / this.perfLoop) * this.perfLoop;
        this.transport.seek(wrapped);
        this.scheduler.seek(wrapped, this.transport.now());
        t = wrapped;
      } else if (this.transport.playing && t >= this.perfDuration) {
        if (this.silentPreview && this.overlayEl) this.restart(true);
        else {
          this.transport.pause();
          this.transport.seek(this.perfDuration);
          this.finished = true;
          this.updatePlayButton();
        }
        t = this.transport.position;
      }
      // line visuals up with what is heard (not while recording: the file has no device latency)
      if (!this.recorder.recording && this.audio.running) t = Math.max(0, t - this.audio.outputLatency);
    } else if (this.transport.playing) {
      scene.update(dt * this.settings.simSpeed, t);
    }
    dl.begin();
    dl.glowScale = app.glow;
    dl.haloScale = 0.4 + app.glow * 0.6;
    this.particles.enabled = app.particles;
    this.particles.density = app.particleDensity;
    this.trails.enabled = app.trails;
    this.trails.length = app.trailLength;
    scene.render(dl, t, dt);
    scene.hud?.(dl, t, this.renderer.aspect);
    this.drawHud(t);
    this.camera.aspect = this.renderer.aspect;
    this.camera.padTop = app.showTitle ? 0.11 : 0;
    this.camera.update(dt);
    dl.end();
    this.renderer.render(this.camera, nowMs / 1000);
    this.els.time.textContent = this.scheduler && !this.perfLoop ? `${fmtTime(t)} / ${fmtTime(this.perfDuration)}` : fmtTime(t);
    this.loopTakeTick();
    this.recordingTick(t);
  }

  private drawHud(t: number): void {
    const dl = this.renderer.draw;
    const app = this.settings.appearance;
    const pal = getPalette(app.palette);
    const aspect = this.renderer.aspect;
    const perf = this.scene.performance?.();
    if (app.showTitle) {
      const x = -aspect + 0.07;
      if (perf && perf.songId) {
        const s = allScores().find((x) => x.id === perf.songId);
        if (s) {
          dl.text(s.title, x, 0.9, 0.075, pal.text, 0.92, 'left', 'hud');
          dl.text(`${s.composer} · ${s.catalog}`, x, 0.82, 0.042, pal.dim, 0.9, 'left', 'hud');
          const ph = perf.phraseAt(t);
          if (ph) dl.text(ph, x, 0.76, 0.04, pal.accent, 0.8, 'left', 'hud');
        }
        const p = clamp(t / Math.max(1, perf.duration), 0, 1);
        dl.rect(0, -0.985, aspect, 0.006, 0, pal.grid, 0.6, 0, 0, 0, 'hud');
        dl.rect(-aspect + aspect * p, -0.985, aspect * p, 0.006, 0, pal.accent, 0.9, 0, 0, 0, 'hud');
      } else {
        dl.text(this.scene.info.title, x, 0.9, 0.06, pal.text, 0.85, 'left', 'hud');
      }
    }
    if (app.showCounters) {
      const st = this.scene.stats?.() ?? [];
      let y = 0.9;
      for (const [k, v] of st) {
        dl.text(`${k}  ${v}`, aspect - 0.06, y, 0.042, pal.dim, 0.9, 'right', 'hud');
        y -= 0.065;
      }
    }
  }

  // ------------------------------------------------------------------ layout

  private exportSize(): [number, number] {
    const ex = this.settings.export;
    return EXPORT_SIZES[ex.aspect][ex.res];
  }

  layout(): void {
    if (!this.renderer) return;
    const rect = this.stage.getBoundingClientRect();
    const availW = Math.max(50, rect.width);
    const availH = Math.max(50, rect.height);
    let cssW = availW;
    let cssH = availH;
    const framed = this.settings.export.framePreview || !!this.recordingSize;
    if (framed) {
      const [w, h2] = this.recordingSize ?? this.exportSize();
      const s = Math.min(availW / w, availH / h2);
      cssW = Math.floor(w * s);
      cssH = Math.floor(h2 * s);
    }
    this.frameBox.style.width = `${cssW}px`;
    this.frameBox.style.height = `${cssH}px`;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    if (this.recordingSize) this.renderer.setPixelSize(this.recordingSize[0], this.recordingSize[1]);
    else {
      const dpr = Math.min(window.devicePixelRatio || 1, this.settings.export.dprCap);
      this.renderer.setPixelSize(cssW * dpr, cssH * dpr);
    }
    this.camera.aspect = this.renderer.aspect;
    if (this.camera.mode === 'overview') this.camera.snapToOverview();
  }

  // ------------------------------------------------------------------ pointer & keys

  private attachPointer(): void {
    const c = this.canvas;
    const toWorld = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return this.camera.screenToWorld(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    };
    const pxSize = () => this.camera.height / Math.max(1, c.getBoundingClientRect().height);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.focus({ preventScroll: true });
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        this.scene.pointer?.({ type: 'cancel', x: 0, y: 0, pxSize: pxSize(), button: 0, shift: false, pointerId: e.pointerId });
        return;
      }
      const w = toWorld(e);
      if (e.button === 1 || e.button === 2) {
        this.panDrag = { x: e.clientX, y: e.clientY };
        return;
      }
      const handled = this.scene.pointer?.({ type: 'down', x: w.x, y: w.y, pxSize: pxSize(), button: e.button, shift: e.shiftKey, pointerId: e.pointerId }) ?? false;
      if (!handled) this.panDrag = { x: e.clientX, y: e.clientY };
    });
    c.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (prev) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        const r = c.getBoundingClientRect();
        const ws = this.camera.height / r.height;
        this.camera.pan(-(cx - this.pinch.cx) * ws, (cy - this.pinch.cy) * ws);
        const wc = this.camera.screenToWorld(cx - r.left, cy - r.top, r.width, r.height);
        if (d > 10 && this.pinch.d > 10) this.camera.zoomAt(this.pinch.d / d, wc.x, wc.y);
        this.pinch = { d, cx, cy };
        return;
      }
      if (this.panDrag) {
        const r = c.getBoundingClientRect();
        const ws = this.camera.height / r.height;
        this.camera.pan(-(e.clientX - this.panDrag.x) * ws, (e.clientY - this.panDrag.y) * ws);
        this.panDrag = { x: e.clientX, y: e.clientY };
        return;
      }
      const w = toWorld(e);
      this.scene.pointer?.({ type: 'move', x: w.x, y: w.y, pxSize: pxSize(), button: e.button, shift: e.shiftKey, pointerId: e.pointerId });
    });
    const end = (e: PointerEvent, type: 'up' | 'cancel') => {
      this.pointers.delete(e.pointerId);
      if (this.pinch) {
        if (this.pointers.size < 2) this.pinch = null;
        return;
      }
      if (this.panDrag) {
        this.panDrag = null;
        return;
      }
      const w = toWorld(e);
      this.scene.pointer?.({ type, x: w.x, y: w.y, pxSize: pxSize(), button: e.button, shift: e.shiftKey, pointerId: e.pointerId });
    };
    c.addEventListener('pointerup', (e) => end(e, 'up'));
    c.addEventListener('pointercancel', (e) => end(e, 'cancel'));
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const w = toWorld(e);
        this.camera.zoomAt(Math.exp(clamp(e.deltaY, -200, 200) * 0.0015), w.x, w.y);
      },
      { passive: false },
    );
  }

  private keydown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return;
    const onSelect = e.target instanceof HTMLSelectElement;
    if (e.key === 'Escape' && this.root.classList.contains('clean')) {
      this.setClean(false);
      e.preventDefault();
      return;
    }
    if (e.key === ' ' && !onSelect) {
      if (e.target instanceof HTMLButtonElement && e.target !== this.els.play) e.target.blur();
      e.preventDefault();
      this.togglePlay();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (this.scene.keydown?.(e)) e.preventDefault();
      return;
    }
    if (onSelect) return;
    const k = e.key.toLowerCase();
    if (k === 'r') {
      e.preventDefault();
      this.userRestart();
    } else if (k === 'h') {
      e.preventDefault();
      this.togglePanel();
    } else if (k === '.') {
      this.stepOnce();
    } else if (this.scene.keydown?.(e)) {
      e.preventDefault();
    }
  }

  private togglePanel(): void {
    this.root.classList.toggle('panel-hidden');
    requestAnimationFrame(() => this.layout());
  }

  private setClean(on: boolean): void {
    this.root.classList.toggle('clean', on);
    if (on) {
      this.cleanHint.classList.add('show');
      setTimeout(() => this.cleanHint.classList.remove('show'), 2500);
    }
    requestAnimationFrame(() => this.layout());
  }

  // ------------------------------------------------------------------ panel

  private buildPanel(): void {
    const p = this.panel;
    clear(p);
    const section = (title: string, open: boolean, ...children: (Node | null)[]) => h('details', { open }, h('summary', {}, title), h('div', { class: 'body' }, ...children));

    // Scene
    this.sceneControls = h('div', { class: 'body', style: 'padding:0' });
    this.statsEl = h('div', { class: 'stats' });
    const loop = this.scene.loopInfo?.();
    p.append(
      section(
        this.scene.info.title,
        true,
        h('p', { class: 'blurb' }, this.scene.info.blurb),
        h('div', { class: 'motion' }, this.scene.info.motion),
        loop ? h('p', { class: 'note' }, loop) : null,
        this.statsEl,
        this.sceneControls,
      ),
    );
    this.renderSceneControls();

    // Song info (performance)
    this.songInfo = h('div', { class: 'body', style: 'padding:0' });
    if (this.entry.mode === 'performance') {
      p.append(section('Music & source', false, this.songInfo));
      this.renderSongInfo();
    }

    // Sound
    p.append(section('Sound', false, this.soundControls()));
    // Camera
    p.append(
      section(
        'Camera',
        false,
        h(
          'div',
          { class: 'btnrow' },
          h('button', { class: 'btn', type: 'button', onclick: () => this.camera.setMode('overview') }, 'Overview'),
          h('button', { class: 'btn', type: 'button', onclick: () => this.camera.setMode('follow'), title: 'Smoothly follow the action (performance scenes anticipate the next notes)' }, 'Follow'),
          h('button', { class: 'btn', type: 'button', onclick: () => this.camera.reset() }, 'Reset view'),
        ),
        h('p', { class: 'note' }, 'Wheel or pinch to zoom; right-drag (or drag empty space in performances / two fingers) to pan. Any manual move switches to manual camera.'),
      ),
    );
    // Appearance
    p.append(section('Appearance', false, this.appearanceControls()));
    // Export
    p.append(section('Export video & images', false, this.exportControls()));
    // Projects
    p.append(section('Projects & settings', false, this.projectControls()));
    // About
    p.append(section('About & music sources', false, this.aboutContent()));
  }

  private renderSceneControls(): void {
    if (!this.sceneControls) return;
    clear(this.sceneControls);
    const defs = this.scene.params.filter((d) => d.key !== 'song');
    renderParams(this.sceneControls, defs, this.scene.values, {
      grouped: true,
      onChange: (k, v) => this.setSceneParam(k, v),
      locked: (d) => (this.isLocked(d) ? 'Locked while recording' : null),
    });
  }

  private renderSongInfo(): void {
    const perf = this.scene.performance?.();
    clear(this.songInfo);
    const s = perf ? allScores().find((x) => x.id === perf.songId) : undefined;
    if (!s) {
      this.songInfo.append(h('p', { class: 'note' }, 'No song loaded.'));
      return;
    }
    this.songInfo.append(sourceCard(s, true));
    const songDef = this.scene.params.find((d) => d.key === 'song');
    const unavailable = songDef?.options?.filter((o) => o.disabled) ?? [];
    if (unavailable.length) this.songInfo.append(h('p', { class: 'note' }, 'Not available in this scene: ' + unavailable.map((o) => `${o.label} (${o.disabled})`).join('; ')));
    // optional: import note-event JSON (validated data only, kept for this session)
    const ta = h('textarea', { 'aria-label': 'Score JSON to import', spellcheck: false, placeholder: 'Paste a kinetic-score/score@1 JSON object' }) as HTMLTextAreaElement;
    const msg = h('p', { class: 'note' }, 'You are responsible for the rights to anything you import. Imported scores are validated as plain data (never executed) and kept only for this session.');
    this.songInfo.append(
      h('div', { class: 'group-title' }, 'Import a score (optional)'),
      ta,
      h('div', { class: 'btnrow' }, h('button', { class: 'btn', type: 'button', onclick: () => this.importScore(ta.value, msg) }, 'Validate & import')),
      msg,
    );
  }

  private importScore(text: string, msg: HTMLElement): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      msg.textContent = `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
      msg.className = 'note err';
      return;
    }
    const errs = validateScore(raw);
    if (errs.length) {
      msg.textContent = `Score rejected: ${errs.slice(0, 4).join(' ')}`;
      msg.className = 'note err';
      return;
    }
    const s = JSON.parse(JSON.stringify(raw)) as ScoreData;
    s.id = `import-${s.id}`.slice(0, 64);
    s.priority = false;
    registerScore(s);
    const id = this.entry.id;
    this.scene.dispose();
    this.switchSceneFresh(id);
    const def = this.scene.params.find((d) => d.key === 'song');
    const opt = def?.options?.find((o) => o.value === s.id);
    if (opt && !opt.disabled) {
      this.setSceneParam('song', s.id);
      this.notify(`Imported “${s.title}”`);
    } else this.notify(`Imported “${s.title}”, but this scene cannot perform it: ${opt?.disabled ?? 'unknown reason'}`, 'warn');
  }

  private soundControls(): HTMLElement {
    const box = h('div', { class: 'body', style: 'padding:0' });
    const a = this.settings.audio;
    const status = h('p', { class: 'note' }, this.audio.running ? 'Audio is running.' : 'Audio is off. Use “Sound off” in the header (or the start card) to enable it — no sound plays before you do.');
    box.append(status);
    const defs: ParamDef[] = [
      { key: 'master', label: 'Master volume', type: 'range', min: 0, max: 1, step: 0.01, applies: 'live' },
      { key: 'muted', label: 'Mute speakers', type: 'toggle', applies: 'live', hint: 'Recordings still capture the mix while speakers are muted.' },
      { key: 'ambience', label: 'Subtle room ambience', type: 'toggle', applies: 'live' },
      { key: 'mech', label: 'Mechanical sounds', type: 'range', min: 0, max: 1, step: 0.01, applies: 'live', hint: 'Quiet ticks from non-musical contacts and machinery' },
      ...INSTRUMENTS.map((i) => ({ key: `inst.${i.id}`, label: i.label, type: 'range' as const, min: 0, max: 1, step: 0.01, applies: 'live' as const, group: 'Voice volumes', hint: i.hint })),
    ];
    const values: Record<string, ParamValue> = { master: a.master, muted: a.muted, ambience: a.ambience, mech: a.mech };
    for (const i of INSTRUMENTS) values[`inst.${i.id}`] = a.inst[i.id];
    renderParams(box, defs, values, {
      grouped: true,
      onChange: (k, v) => {
        if (k === 'master') a.master = Number(v);
        else if (k === 'muted') a.muted = v === true;
        else if (k === 'ambience') a.ambience = v === true;
        else if (k === 'mech') a.mech = Number(v);
        else if (k.startsWith('inst.')) a.inst[k.slice(5) as keyof typeof a.inst] = Number(v);
        this.applyAudioSettings();
        this.updateAudioButton();
        this.persist();
      },
    });
    const test = h('button', { class: 'btn', type: 'button', onclick: () => this.testSound() }, 'Test sound');
    box.append(h('div', { class: 'btnrow' }, test));
    return box;
  }

  private async testSound(): Promise<void> {
    if (!this.audio.running) await this.enableAudio(false);
    const t = this.audio.now() + 0.05;
    INSTRUMENTS.forEach((i, k) => this.audio.play(i.id, 60 + [0, 4, 7, 12, 16, 19][k], { vel: 0.7, when: t + k * 0.28, dur: 0.4 }));
  }

  private applyAudioSettings(): void {
    const a = this.settings.audio;
    this.audio.setMasterVolume(a.master);
    this.audio.setMuted(a.muted);
    this.audio.setAmbience(a.ambience);
    this.audio.setMechVolume(a.mech);
    for (const i of INSTRUMENTS) this.audio.setInstrumentVolume(i.id, a.inst[i.id]);
  }

  private appearanceControls(): HTMLElement {
    const box = h('div', { class: 'body', style: 'padding:0' });
    const ap = this.settings.appearance;
    const defs: ParamDef[] = [
      { key: 'palette', label: 'Palette', type: 'select', applies: 'live', options: PALETTES.map((p) => ({ value: p.id, label: p.label })) },
      { key: 'glow', label: 'Glow', type: 'range', min: 0, max: 2, step: 0.05, applies: 'live' },
      { key: 'grid', label: 'Background grid & stars', type: 'range', min: 0, max: 2, step: 0.05, applies: 'live' },
      { key: 'trails', label: 'Trails', type: 'toggle', applies: 'live' },
      { key: 'trailLength', label: 'Trail length', type: 'range', min: 0.1, max: 2, step: 0.05, unit: 's', applies: 'live', visible: () => ap.trails },
      { key: 'particles', label: 'Particles', type: 'toggle', applies: 'live' },
      { key: 'particleDensity', label: 'Particle density', type: 'range', min: 0.2, max: 2, step: 0.1, applies: 'live', visible: () => ap.particles },
      { key: 'noteLabels', label: 'Note labels', type: 'toggle', applies: 'live' },
      { key: 'highlights', label: 'Trigger highlights', type: 'toggle', applies: 'live' },
      { key: 'showTitle', label: 'Title overlay', type: 'toggle', applies: 'live', hint: 'Drawn into the canvas, so it appears in recordings' },
      { key: 'showCounters', label: 'Counters overlay', type: 'toggle', applies: 'live' },
    ];
    const rerender = () => {
      clear(box);
      renderParams(box, defs, ap as unknown as Record<string, ParamValue>, {
        onChange: (k, v) => {
          (ap as unknown as Record<string, ParamValue>)[k] = v;
          this.applyAppearance();
          this.persist();
          if (k === 'trails' || k === 'particles') rerender();
        },
      });
    };
    rerender();
    return box;
  }

  private applyAppearance(): void {
    if (!this.renderer) return;
    this.renderer.applyPalette(getPalette(this.settings.appearance.palette), this.settings.appearance.grid);
  }

  private exportControls(): HTMLElement {
    const box = h('div', { class: 'body', style: 'padding:0' });
    const sup = recordingSupport();
    const ex = this.settings.export;
    const defs: ParamDef[] = [
      { key: 'aspect', label: 'Frame', type: 'select', applies: 'live', options: [{ value: 'portrait', label: 'Portrait 9:16' }, { value: 'square', label: 'Square 1:1' }, { value: 'landscape', label: 'Landscape 16:9' }] },
      { key: 'res', label: 'Resolution', type: 'select', applies: 'live', options: [{ value: 'hd', label: '720p (fast)' }, { value: 'fhd', label: '1080p (sharper, heavier)' }] },
      { key: 'fps', label: 'Frame rate', type: 'select', applies: 'live', options: [{ value: '30', label: '30 fps' }, { value: '60', label: '60 fps (if the browser keeps up)' }] },
      { key: 'framePreview', label: 'Preview the export frame', type: 'toggle', applies: 'live', hint: 'Letterboxes the stage to the export frame. Always on while recording.' },
      { key: 'mode', label: 'Take', type: 'select', applies: 'live', options: [{ value: 'manual', label: 'Manual start / stop' }, { value: 'timed', label: 'Timed' }, { value: 'performance', label: 'Whole performance from the start', disabled: this.entry.mode === 'performance' ? undefined : 'performance scenes only' }, { value: 'loop', label: 'One seamless loop', disabled: this.perfLoop ? undefined : 'looping sequencer scenes only' }] },
      { key: 'timedSeconds', label: 'Timed length', type: 'range', min: 3, max: 120, step: 1, unit: 's', applies: 'live', visible: () => ex.mode === 'timed' },
      { key: 'tail', label: 'Ending tail', type: 'range', min: 0, max: 6, step: 0.5, unit: 's', applies: 'live', visible: () => ex.mode === 'performance', hint: 'Keeps recording after the final note so it can ring out' },
      { key: 'countdown', label: '3-2-1 countdown', type: 'toggle', applies: 'live' },
      { key: 'dprCap', label: 'Preview pixel density cap', type: 'range', min: 0.75, max: 3, step: 0.25, unit: '×', applies: 'live', hint: 'Lower for smoother previews on slow machines; exports always use exact dimensions' },
    ];
    const vals = (): Record<string, ParamValue> => ({ ...ex, fps: String(ex.fps) }) as unknown as Record<string, ParamValue>;
    const ctl = h('div', { class: 'body', style: 'padding:0' });
    const rerender = () => {
      clear(ctl);
      renderParams(ctl, defs, vals(), {
        locked: () => (this.recorder.recording ? 'Locked while recording' : null),
        onChange: (k, v) => {
          if (k === 'fps') ex.fps = Number(v) === 60 ? 60 : 30;
          else (ex as unknown as Record<string, ParamValue>)[k] = v;
          this.persist();
          this.layout();
          if (k === 'mode' || k === 'aspect' || k === 'res') rerender();
        },
      });
      const [w, h2] = this.exportSize();
      ctl.append(h('p', { class: 'note' }, `Output: ${w}×${h2} px · ${ex.fps} fps · ${sup.ok ? sup.choice!.label : 'recording unavailable'}`));
    };
    rerender();
    box.append(ctl);
    this.recordNote = h('p', { class: sup.ok ? 'note' : 'note warn' }, sup.ok ? 'Records the canvas (with glow, trails, particles, title overlay) plus the generated audio, in real time. Real-time capture can drop frames on a busy machine; it is not frame-perfect.' : sup.reason ?? '');
    box.append(this.recordNote);
    box.append(
      h(
        'div',
        { class: 'btnrow' },
        h('button', { class: 'btn primary', type: 'button', disabled: !sup.ok, onclick: () => this.toggleRecord() }, '● Record'),
        h('button', { class: 'btn', type: 'button', onclick: () => this.screenshot() }, '📷 PNG screenshot'),
      ),
    );
    this.exportResult = h('div', { class: 'result' });
    box.append(this.exportResult);
    if (this.recorder.last) this.showResult(this.recorder.last);
    return box;
  }

  private projectControls(): HTMLElement {
    const box = h('div', { class: 'body', style: 'padding:0' });
    const seedInput = h('input', { type: 'number', min: 0, max: 4294967295, value: String(this.settings.seed), 'aria-label': 'Seed', style: 'width:100%;height:32px;border-radius:8px;border:1px solid var(--line-strong);background:var(--panel-solid);padding:0 8px' }) as HTMLInputElement;
    seedInput.addEventListener('change', () => {
      const v = Math.floor(Number(seedInput.value));
      if (Number.isFinite(v) && v >= 0 && v <= 0xffffffff) {
        this.settings.seed = v;
        this.persist();
        this.restart();
      } else seedInput.value = String(this.settings.seed);
    });
    box.append(
      h('div', { class: 'ctl' }, h('label', {}, 'Seed ', h('span', { class: 'tag' }, 'restart')), h('span'), seedInput, h('div', { class: 'hint' }, 'Same seed + same settings = same scene. Applying a seed restarts the scene.')),
      h(
        'div',
        { class: 'btnrow' },
        h('button', { class: 'btn', type: 'button', onclick: () => this.randomize(), title: 'New seed and safe random scene settings' }, '🎲 Safe randomize'),
      ),
    );
    if (!storageAvailable()) box.append(h('p', { class: 'note warn' }, 'Browser storage is unavailable (private mode or disabled): settings will not persist, but you can still copy/paste project JSON below.'));
    const nameInput = h('input', { type: 'text', placeholder: 'Project name', maxlength: 60, 'aria-label': 'Project name', style: 'width:100%;height:32px;border-radius:8px;border:1px solid var(--line-strong);background:var(--panel-solid);padding:0 8px' }) as HTMLInputElement;
    box.append(h('div', { class: 'group-title' }, 'Saved projects'), nameInput, h('div', { class: 'btnrow' }, h('button', { class: 'btn', type: 'button', onclick: () => this.saveProjectAs(nameInput.value) }, 'Save project')));
    this.projectList = h('div', { class: 'body', style: 'padding:0;gap:6px' });
    box.append(this.projectList);
    this.renderProjectList();
    const ta = h('textarea', { 'aria-label': 'Project JSON', spellcheck: false, placeholder: 'Paste project JSON here, then press Import' }) as HTMLTextAreaElement;
    const msg = h('p', { class: 'note' });
    box.append(
      h('div', { class: 'group-title' }, 'Copy / paste'),
      h(
        'div',
        { class: 'btnrow' },
        h('button', { class: 'btn', type: 'button', onclick: () => void this.copyProject(ta, msg) }, 'Copy project JSON'),
        h('button', { class: 'btn', type: 'button', onclick: () => this.importProject(ta.value, msg) }, 'Import'),
      ),
      ta,
      msg,
      h('div', { class: 'btnrow' }, h('button', { class: 'btn', type: 'button', onclick: () => this.resetSettings() }, 'Reset all settings')),
    );
    return box;
  }

  private renderProjectList(): void {
    clear(this.projectList);
    const list = listProjects();
    if (!list.length) this.projectList.append(h('p', { class: 'note' }, 'No saved projects yet.'));
    for (const p of list) {
      this.projectList.append(
        h(
          'div',
          { class: 'source' },
          h('h4', {}, p.name),
          h('div', { class: 'meta' }, `${sceneEntry(p.sceneId)?.title ?? p.sceneId} · ${p.savedAt.slice(0, 16).replace('T', ' ')}`),
          h(
            'div',
            { class: 'btnrow', style: 'margin-top:6px' },
            h('button', { class: 'btn', type: 'button', onclick: () => this.loadProject(p) }, 'Load'),
            h('button', { class: 'btn', type: 'button', onclick: () => {
              deleteProject(p.name);
              this.renderProjectList();
            } }, 'Delete'),
          ),
        ),
      );
    }
  }

  private currentProject(name: string): Project {
    this.saveSceneValues();
    return { schema: 'kinetic-score/project@1', name: name || 'Untitled', savedAt: new Date().toISOString(), sceneId: this.entry.id, settings: JSON.parse(JSON.stringify(this.settings)) as AppSettings };
  }

  private saveProjectAs(name: string): void {
    const n = name.trim() || `${this.scene.info.title} ${new Date().toLocaleString()}`;
    const err = saveProject(this.currentProject(n));
    if (err) this.notify(err, 'warn');
    else this.notify(`Saved “${n}”`);
    this.renderProjectList();
  }

  private loadProject(p: Project): void {
    if (this.recorder.recording) return this.notify('Stop recording first.', 'warn');
    this.settings = JSON.parse(JSON.stringify(p.settings)) as AppSettings;
    this.applyAudioSettings();
    this.applyAppearance();
    (this.els.speedSel as HTMLSelectElement).value = String(this.settings.simSpeed);
    this.scene.dispose();
    this.switchSceneFresh(p.sceneId);
    this.layout();
    this.notify(`Loaded “${p.name}”`);
  }

  /**
   * Switch to a scene after the current one has already been disposed (project load, settings
   * reset, score import): nothing of the old scene is saved over the newly loaded settings.
   */
  private switchSceneFresh(id: string): void {
    const entry = sceneEntry(id) ?? SCENES[0];
    this.scene = null as unknown as Scene;
    this.switchScene(entry.id);
  }

  private async copyProject(ta: HTMLTextAreaElement, msg: HTMLElement): Promise<void> {
    const json = JSON.stringify(this.currentProject(`${this.scene.info.title}`), null, 2);
    ta.value = json;
    try {
      await navigator.clipboard.writeText(json);
      msg.textContent = 'Copied to the clipboard (also shown above).';
      msg.className = 'note';
    } catch {
      ta.select();
      msg.textContent = 'Clipboard access was blocked — the JSON is selected above; copy it manually.';
      msg.className = 'note warn';
    }
  }

  private importProject(text: string, msg: HTMLElement): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      msg.textContent = `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
      msg.className = 'note err';
      return;
    }
    const { project, errors, warnings } = validateProject(raw);
    if (!project) {
      msg.textContent = errors.join(' ');
      msg.className = 'note err';
      return;
    }
    if (!sceneEntry(project.sceneId)) {
      msg.textContent = `Unknown scene “${project.sceneId}”.`;
      msg.className = 'note err';
      return;
    }
    this.loadProject(project);
    msg.textContent = warnings.length ? `Imported with notes: ${warnings.join('; ')}` : 'Imported.';
    msg.className = warnings.length ? 'note warn' : 'note';
  }

  private resetSettings(): void {
    if (this.recorder.recording) return;
    const keepScene = this.entry.id;
    this.settings = defaultSettings();
    this.settings.lastScene = keepScene;
    this.applyAudioSettings();
    this.applyAppearance();
    this.scene.dispose();
    this.switchSceneFresh(keepScene);
    this.persist();
    this.notify('Settings reset to defaults.');
  }

  private randomize(): void {
    if (this.recorder.recording) return this.notify('Locked while recording.', 'warn');
    this.settings.seed = randomSeed();
    const rng = new Rng(this.settings.seed ^ 0x9e3779b9);
    this.scene.randomize?.(() => rng.next());
    this.saveSceneValues();
    this.persist();
    this.restart();
    this.buildPanel();
    this.notify(`Seed ${this.settings.seed}`);
  }

  private aboutContent(): HTMLElement {
    const box = h('div', { class: 'body', style: 'padding:0' });
    box.append(
      h('p', { class: 'note' }, 'Performance scenes use choreographed, deterministic motion: balls follow computed ballistic arcs, guided rails and timed releases so every written note is struck exactly on time by a visible mechanism. Playground scenes are free physics where real contacts make the sound.'),
      h('p', { class: 'note' }, 'All music is synthesised in your browser from bundled note data. Note data was extracted from Mutopia Project MIDI files (typeset from public-domain editions) and arranged into short excerpts — see each entry for its licence, edition and what the arrangement changed. Rights status can differ by country; this is not a worldwide clearance.'),
    );
    for (const s of allScores()) box.append(sourceCard(s, false));
    box.append(h('div', { class: 'group-title' }, 'Not available'));
    for (const u of UNAVAILABLE) box.append(h('div', { class: 'source unavailable' }, h('h4', {}, u.title), h('div', { class: 'meta' }, u.reason)));
    box.append(
      h('div', { class: 'group-title' }, 'Keyboard'),
      h('p', { class: 'note' }, 'Space play/pause · R restart · H show/hide controls · Esc leave clean view · . single step · Builder: E edit/play, Delete remove, D duplicate, Ctrl+Z / Ctrl+Shift+Z undo/redo'),
      h('p', { class: 'note' }, 'Kinetic Score runs entirely in your browser: no accounts, analytics, network audio or microphone/camera access. three.js © its authors (MIT).'),
    );
    return box;
  }

  private updateStats(): void {
    if (!this.statsEl || !this.scene) return;
    const st = this.scene.stats?.() ?? [];
    clear(this.statsEl);
    for (const [k, v] of st.slice(0, 6)) this.statsEl.append(h('div', {}, k, h('b', {}, v)));
    if (this.recorder.recording) {
      const el = this.recStatus.querySelector('.rec-time');
      if (el) el.textContent = `REC ${fmtTime(this.recorder.elapsed)}`;
    }
  }

  // ------------------------------------------------------------------ recording

  private async toggleRecord(): Promise<void> {
    if (this.recorder.recording || this.countdownTimer || this.loopTake) return this.stopRecording();
    const sup = recordingSupport();
    if (!sup.ok) return this.notify(sup.reason ?? 'Recording unsupported', 'warn');
    if (!this.audio.running && this.audio.supported) await this.enableAudio(false);
    let mode = this.settings.export.mode;
    if (mode === 'performance' && this.entry.mode !== 'performance') mode = 'manual';
    if (mode === 'loop' && !this.perfLoop) mode = 'manual';
    this.recordingSize = this.exportSize();
    this.layout();
    this.root.classList.add('recording');
    this.refreshHeader();
    if (mode === 'performance') {
      // reset to the start and hold until the countdown ends
      this.restart(true);
      this.pause();
    }
    const go = () => {
      this.countdownTimer = 0;
      this.countdownEl.classList.remove('on');
      if (mode === 'loop') {
        // pre-roll one full loop (so ringing tails match at the seam), then record exactly one loop
        this.restart(true);
        this.loopTake = { phase: 'preroll', start: this.perfLoop };
        this.notify(`Pre-rolling one loop (${this.perfLoop.toFixed(1)} s) before recording…`);
        return;
      }
      this.beginRecording(mode);
    };
    if (this.settings.export.countdown) {
      let n = 3;
      this.countdownEl.textContent = String(n);
      this.countdownEl.classList.add('on');
      const tick = () => {
        n--;
        if (n <= 0) go();
        else {
          this.countdownEl.textContent = String(n);
          this.countdownTimer = window.setTimeout(tick, 1000);
        }
      };
      this.countdownTimer = window.setTimeout(tick, 1000);
    } else go();
  }

  private loopTakeTick(): void {
    const lt = this.loopTake;
    if (!lt) return;
    const pos = this.transport.position;
    if (lt.phase === 'preroll' && pos >= lt.start) {
      lt.phase = 'rolling';
      this.beginRecording('loop');
    } else if (lt.phase === 'rolling' && pos >= lt.start + this.perfLoop) {
      this.loopTake = null;
      this.stopRecording();
    }
  }

  private beginRecording(mode: 'manual' | 'timed' | 'performance' | 'loop'): void {
    const [w, h2] = this.recordingSize!;
    const perf = this.scene.performance?.();
    const base = `kinetic-score_${this.entry.id}${perf?.songId ? '_' + perf.songId : ''}${mode === 'loop' ? '_loop' : ''}`;
    const err = this.recorder.start(this.canvas, this.audio.recordingStream, this.settings.export.fps, w, h2, base);
    if (err) {
      this.notify(err, 'warn');
      this.afterRecording();
      return;
    }
    this.recordPerformance = mode === 'performance';
    this.recordStartWall = performance.now();
    this.recordStopAt = mode === 'timed' ? this.settings.export.timedSeconds : null;
    if (mode === 'performance') this.play();
    this.recStatus.classList.add('on');
    this.els.rec.classList.add('on');
    this.els.rec.textContent = '■ Stop';
    this.refreshHeader();
    this.renderSceneControls();
    if (!this.audio.recordingStream) this.notify('Recording without audio (audio is unavailable).', 'warn');
  }

  private recordingTick(t: number): void {
    if (!this.recorder.recording) return;
    const elapsed = (performance.now() - this.recordStartWall) / 1000;
    if (this.recordStopAt !== null && elapsed >= this.recordStopAt) this.stopRecording();
    else if (this.recordPerformance && (this.finished || t >= this.perfDuration) && t >= this.perfDuration - 0.01) {
      // keep rolling for the decay tail after the final note
      if (this.recordStopAt === null) this.recordStopAt = elapsed + this.settings.export.tail;
    }
  }

  private stopRecording(): void {
    if (this.loopTake && !this.recorder.recording) {
      this.loopTake = null;
      this.afterRecording();
      return;
    }
    this.loopTake = null;
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = 0;
      this.countdownEl.classList.remove('on');
      this.afterRecording();
      return;
    }
    if (this.recorder.recording) this.recorder.stop();
  }

  private afterRecording(): void {
    this.recordingSize = null;
    this.recordPerformance = false;
    this.recordStopAt = null;
    this.root.classList.remove('recording');
    this.recStatus.classList.remove('on');
    this.els.rec.classList.remove('on');
    this.els.rec.textContent = '● Rec';
    this.layout();
    this.refreshHeader();
    this.renderSceneControls();
  }

  private recordingDone(r: RecordingResult): void {
    this.afterRecording();
    this.notify(`Recording ready: ${r.filename}`);
    this.showResult(r);
    const det = this.exportResult?.closest('details');
    if (det) (det as HTMLDetailsElement).open = true;
    if (this.root.classList.contains('panel-hidden')) this.togglePanel();
  }

  private showResult(r: RecordingResult): void {
    if (!this.exportResult) return;
    clear(this.exportResult);
    const video = h('video', { controls: true, playsinline: true, src: r.url, preload: 'metadata' });
    const sizeMb = (r.blob.size / 1e6).toFixed(1);
    this.exportResult.append(
      video,
      h('p', { class: 'note' }, `${r.filename} · ${r.width}×${r.height} · ${r.seconds.toFixed(1)} s · ${sizeMb} MB · ${r.mime}${r.hasAudio ? ' · with audio' : ' · no audio track'}`),
      h('div', { class: 'btnrow' }, h('a', { class: 'btn primary', href: r.url, download: r.filename }, '⬇ Download')),
    );
  }

  private screenshot(): void {
    if (!this.renderer) return;
    const framed = this.settings.export.framePreview && !this.recordingSize;
    const restore = framed ? [this.renderer.pixelWidth, this.renderer.pixelHeight] : null;
    if (framed) {
      const [w, h2] = this.exportSize();
      this.renderer.setPixelSize(w, h2);
    }
    // render a fresh frame and read it back in the same task
    this.camera.aspect = this.renderer.aspect;
    const dl = this.renderer.draw;
    dl.begin();
    this.scene.render(dl, this.transport.position, 0);
    this.scene.hud?.(dl, this.transport.position, this.renderer.aspect);
    this.drawHud(this.transport.position);
    dl.end();
    this.renderer.render(this.camera, performance.now() / 1000);
    const w = this.renderer.pixelWidth;
    const h2 = this.renderer.pixelHeight;
    this.canvas.toBlob((blob) => {
      if (!blob) return this.notify('Screenshot failed.', 'warn');
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      downloadBlob(blob, `kinetic-score_${this.entry.id}_${w}x${h2}_${stamp}.png`);
      this.notify('Screenshot saved');
    }, 'image/png');
    if (restore) this.renderer.setPixelSize(restore[0], restore[1]);
  }

  // ------------------------------------------------------------------ misc

  notify(msg: string, kind: 'info' | 'warn' = 'info'): void {
    if (!this.toastBox) return;
    const t = h('div', { class: `toast ${kind === 'warn' ? 'warn' : ''}` }, msg);
    this.toastBox.append(t);
    while (this.toastBox.children.length > 3) this.toastBox.firstElementChild?.remove();
    setTimeout(() => t.remove(), kind === 'warn' ? 5000 : 2800);
  }

  private persist(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      if (this.scene) this.saveSceneValues();
      saveSettings(this.settings);
    }, 400);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    clearInterval(this.statsTimer);
    this.recorder.dispose();
    this.scene?.dispose();
    this.renderer?.dispose();
  }

  /** world → client (CSS px) coordinates, for automated interaction tests */
  worldToClient(x: number, y: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((x - this.camera.x) / this.camera.width + 0.5) * r.width, y: r.top + (0.5 - (y - this.camera.y) / this.camera.height) * r.height };
  }

  /** for tests: pause at a given transport time */
  debugSeek(t: number): void {
    this.pause();
    this.transport.seek(t);
    this.scheduler?.seek(t, this.transport.now());
  }

  /** for tests: run a named scene action */
  debugScene(): Scene {
    return this.scene;
  }

  // test/debug hooks (used by the browser smoke test)
  debugState(): Record<string, unknown> {
    return {
      scene: this.entry?.id,
      mode: this.entry?.mode,
      position: this.transport.position,
      playing: this.transport.playing,
      audio: this.audio.running,
      voices: this.audio.activeVoices,
      scheduled: this.scheduler?.scheduledCount ?? 0,
      instances: this.renderer?.draw.instanceCount ?? 0,
      pixel: [this.renderer?.pixelWidth, this.renderer?.pixelHeight],
      stats: this.scene?.stats?.() ?? [],
      recording: this.recorder.recording,
    };
  }
}

function sourceCard(s: ReturnType<typeof allScores>[number], detailed: boolean): HTMLElement {
  return h(
    'div',
    { class: 'source' },
    h('h4', {}, `${s.composer} — ${s.title}`),
    h('div', { class: 'meta' }, `${s.work} · ${s.catalog} · ${s.movement}`),
    h('div', {}, `Excerpt: ${s.excerpt}`),
    h('div', { class: 'meta' }, `Source: ${s.source.collection}${s.source.mutopiaId ? ` #${s.source.mutopiaId}` : ''} — ${s.source.edition}. Licence: ${s.source.license}.`),
    s.source.url ? h('a', { href: s.source.url, target: '_blank', rel: 'noopener noreferrer' }, 'Mutopia entry') : null,
    detailed ? h('div', { class: 'meta' }, s.source.note) : null,
    detailed ? h('ul', { style: 'margin:6px 0 0;padding-left:16px' }, ...s.arrangement.map((a) => h('li', {}, a))) : null,
    detailed ? h('div', { class: 'meta' }, `Tempo ${s.tempo.bpm} bpm${s.tempo.rampTo !== 1 ? ` accelerating to ${(s.tempo.bpm * s.tempo.rampTo).toFixed(0)}` : ''} · ${s.meter.numerator}/${s.meter.denominator} · ${s.notes.length} notes`) : null,
  );
}
