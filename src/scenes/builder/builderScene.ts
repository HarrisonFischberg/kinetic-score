// PLAYGROUND · Builder: free physics sandbox. Click empty space to drop a ball,
// drag from the launcher to aim and launch, switch to Edit to place, move, tune
// and delete ramps, walls, bumpers, funnels, musical pads and note gates.
import type { Collider, ContactEvent } from '../../simulation/physics.ts';
import { Rng } from '../../core/rng.ts';
import { clamp, closestOnSegment, dist } from '../../core/math.ts';
import type { DrawList, RGB } from '../../rendering/draw.ts';
import { pitchColor, paletteHue } from '../../rendering/palette.ts';
import { INSTRUMENTS, type InstrumentId } from '../../audio/instruments.ts';
import { chordDegrees, degreeToMidi, rootOptions, scaleOptions, type ChordKind } from '../../music/scales.ts';
import { noteName } from '../../music/score.ts';
import type { Scene, SceneServices, ParamDef, ParamValue, ScenePointer } from '../types.ts';
import { PhysicsHost, ballVisual } from '../physicsScene.ts';
import { cloneLayout, defaultMusic, hasMusic, validateLayout, type ElementKind, type Layout, type LayoutElement, type Retrigger } from './layout.ts';
import { BUILDER_PRESETS } from './presets.ts';

type Tool = 'select' | ElementKind;
type Drag =
  | { type: 'aim'; x: number; y: number }
  | { type: 'drop'; sx: number; sy: number; x: number; y: number; moved: boolean }
  | { type: 'move'; id: number; ox: number; oy: number; orig: LayoutElement; snapshot: boolean }
  | { type: 'handle'; id: number; which: 1 | 2 | 'r'; snapshot: boolean }
  | { type: 'spawner'; ox: number; oy: number; snapshot: boolean }
  | { type: 'place'; kind: ElementKind; x1: number; y1: number; x2: number; y2: number };

interface Runtime {
  lastHit: number;
  seqIndex: number;
  lastBall: number;
  lastPitch: number;
}

const TOOL_LABEL: Record<Tool, string> = { select: 'Select / move', ramp: 'Ramp', wall: 'Wall', bumper: 'Bumper', funnel: 'Funnel', pad: 'Musical pad', gate: 'Note gate' };

export class BuilderScene implements Scene {
  readonly info = {
    id: 'builder',
    title: 'Builder Sandbox',
    mode: 'playground' as const,
    blurb: 'Drop and launch marbles through ramps, bumpers and tuned pads. Switch to Edit to build your own machine.',
    motion: 'Sandbox · real physical contacts trigger every note',
  };
  values: Record<string, ParamValue> = {
    preset: 'stairs',
    mode: 'play',
    tool: 'select',
    scale: 'majorPent',
    root: '2',
    gravity: 9.8,
    restitution: 0.72,
    friction: 0.08,
    ballRadius: 0.22,
    launchSpeed: 13,
    spawnRate: 0,
    ballCap: 80,
    ballCollisions: true,
    'sel.degree': 0,
    'sel.instrument': 'marimba',
    'sel.velSens': 0.6,
    'sel.retrigger': 'cooldown',
    'sel.cooldownMs': 90,
    'sel.chord': 'none',
    'sel.sequence': false,
    'sel.seqStep': 1,
    'sel.seqLength': 4,
    'sel.kind': '',
  };
  readonly params: ParamDef[];
  private host = new PhysicsHost();
  private svc!: SceneServices;
  private layout!: Layout;
  private baseline!: Layout;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private colliders = new Map<number, Collider[]>();
  private runtime = new Map<number, Runtime>();
  private selected: number | null = null;
  private drag: Drag | null = null;
  private pointerWorld = { x: 0, y: 0 };
  private rng = new Rng(1);
  private spawnAcc = 0;
  private nextId = 1000;
  private hover = false;

  constructor() {
    const isEdit = (v: Record<string, ParamValue>) => v.mode === 'edit';
    const selMusical = (v: Record<string, ParamValue>) => v.mode === 'edit' && typeof v['sel.kind'] === 'string' && hasMusic(v['sel.kind'] as ElementKind);
    const selSeq = (v: Record<string, ParamValue>) => selMusical(v) && v['sel.sequence'] === true;
    this.params = [
      { key: 'mode', label: 'Mode', type: 'select', applies: 'live', group: 'Builder', options: [{ value: 'play', label: 'Play — drop & launch' }, { value: 'edit', label: 'Edit — build (sim paused)' }], hint: 'E toggles. Play: click empty space drops a ball, drag the launcher ring to aim and release to launch. Edit: the simulation pauses so you can place and move parts.' },
      { key: 'tool', label: 'Tool', type: 'select', applies: 'live', group: 'Builder', visible: isEdit, options: (Object.keys(TOOL_LABEL) as Tool[]).map((t) => ({ value: t, label: TOOL_LABEL[t] })), hint: 'Line parts: drag to draw. Bumper/funnel: click to place. Select: drag parts or their end handles; Delete removes.' },
      { key: 'undo', label: 'Undo', type: 'button', applies: 'live', group: 'Builder' },
      { key: 'redo', label: 'Redo', type: 'button', applies: 'live', group: 'Builder' },
      { key: 'delete', label: 'Delete selected', type: 'button', applies: 'live', group: 'Builder', visible: (v) => isEdit(v) && v['sel.kind'] !== '' },
      { key: 'duplicate', label: 'Duplicate selected', type: 'button', applies: 'live', group: 'Builder', visible: (v) => isEdit(v) && v['sel.kind'] !== '' },
      { key: 'sel.degree', label: 'Pitch (scale degree)', type: 'range', min: -10, max: 20, step: 1, applies: 'live', group: 'Selected element', visible: selMusical },
      { key: 'sel.instrument', label: 'Instrument', type: 'select', applies: 'live', group: 'Selected element', visible: selMusical, options: INSTRUMENTS.map((i) => ({ value: i.id, label: i.label })) },
      { key: 'sel.velSens', label: 'Velocity sensitivity', type: 'range', min: 0, max: 1, step: 0.05, applies: 'live', group: 'Selected element', visible: selMusical, hint: '0 = every hit equally loud; 1 = loudness follows impact speed' },
      { key: 'sel.retrigger', label: 'Retrigger', type: 'select', applies: 'live', group: 'Selected element', visible: selMusical, options: [{ value: 'cooldown', label: 'Cooldown' }, { value: 'mono', label: 'Once per ball visit' }, { value: 'always', label: 'Every contact' }] },
      { key: 'sel.cooldownMs', label: 'Cooldown', type: 'range', min: 0, max: 1000, step: 10, unit: 'ms', applies: 'live', group: 'Selected element', visible: (v) => selMusical(v) && v['sel.retrigger'] === 'cooldown' },
      { key: 'sel.chord', label: 'Chord', type: 'select', applies: 'live', group: 'Selected element', visible: selMusical, options: [{ value: 'none', label: 'Single note' }, { value: 'octave', label: 'Octave' }, { value: 'fifth', label: 'Fifth' }, { value: 'triad', label: 'Triad' }, { value: 'seventh', label: 'Seventh' }] },
      { key: 'sel.sequence', label: 'Advance sequence on each hit', type: 'toggle', applies: 'live', group: 'Selected element', visible: selMusical },
      { key: 'sel.seqStep', label: 'Sequence step (degrees)', type: 'range', min: -5, max: 5, step: 1, applies: 'live', group: 'Selected element', visible: selSeq },
      { key: 'sel.seqLength', label: 'Sequence length', type: 'range', min: 2, max: 8, step: 1, applies: 'live', group: 'Selected element', visible: selSeq },
      { key: 'preset', label: 'Starting layout', type: 'select', applies: 'restart', group: 'Scene', options: BUILDER_PRESETS.map((p) => ({ value: p.id, label: p.label })), hint: 'Reset (R) restores the starting layout. Choosing a preset replaces it.' },
      { key: 'commitLayout', label: 'Use current layout as the start', type: 'button', applies: 'live', group: 'Scene', hint: 'Makes your edits the layout that Reset returns to (it is also saved with your settings)' },
      { key: 'scale', label: 'Scale', type: 'select', applies: 'live', group: 'Music', options: scaleOptions() },
      { key: 'root', label: 'Key', type: 'select', applies: 'live', group: 'Music', options: rootOptions() },
      { key: 'gravity', label: 'Gravity', type: 'range', min: 0, max: 30, step: 0.1, applies: 'live', group: 'Physics' },
      { key: 'restitution', label: 'Bounciness', type: 'range', min: 0, max: 1, step: 0.01, applies: 'live', group: 'Physics' },
      { key: 'friction', label: 'Friction', type: 'range', min: 0, max: 1, step: 0.01, applies: 'live', group: 'Physics' },
      { key: 'ballRadius', label: 'Ball radius', type: 'range', min: 0.1, max: 0.6, step: 0.01, applies: 'live', group: 'Physics', hint: 'Applies to new balls' },
      { key: 'launchSpeed', label: 'Launch speed', type: 'range', min: 2, max: 30, step: 0.5, applies: 'live', group: 'Physics' },
      { key: 'spawnRate', label: 'Auto-spawn rate', type: 'range', min: 0, max: 6, step: 0.1, unit: '/s', applies: 'live', group: 'Physics', hint: 'Balls per second fired from the launcher (0 = off)' },
      { key: 'ballCap', label: 'Ball cap', type: 'range', min: 5, max: 250, step: 1, applies: 'live', group: 'Physics', hint: 'Oldest balls fade out above this count' },
      { key: 'ballCollisions', label: 'Ball–ball collisions', type: 'toggle', applies: 'live', group: 'Physics' },
      { key: 'clearBalls', label: 'Clear balls', type: 'button', applies: 'live', group: 'Physics' },
    ];
  }

  init(svc: SceneServices): void {
    this.svc = svc;
    this.host.init(svc);
    this.host.onContact = (e) => this.contact(e);
    this.host.onStep = (dt) => this.autoSpawn(dt);
    this.loadPreset(String(this.values.preset));
  }

  private loadPreset(id: string): void {
    const p = BUILDER_PRESETS.find((x) => x.id === id) ?? BUILDER_PRESETS[0];
    this.baseline = p.make();
    this.layout = cloneLayout(this.baseline);
    this.undoStack = [];
    this.redoStack = [];
    this.reset();
  }

  /** Replace the layout (from a saved project). */
  setLayout(l: Layout, asBaseline = true): string[] {
    const errs = validateLayout(l);
    if (errs.length) return errs;
    if (asBaseline) this.baseline = cloneLayout(l);
    this.layout = cloneLayout(l);
    this.undoStack = [];
    this.redoStack = [];
    this.reset();
    return [];
  }

  getLayout(): Layout {
    return cloneLayout(this.layout);
  }

  reset(): void {
    this.layout = cloneLayout(this.baseline);
    this.host.reset();
    this.svc.trails.clear();
    this.svc.particles.clear();
    this.rng = new Rng(this.svc.seed());
    this.spawnAcc = 0;
    this.runtime.clear();
    this.selected = null;
    this.drag = null;
    this.nextId = Math.max(1000, ...this.layout.elements.map((e) => e.id + 1));
    this.applyPhysicsParams();
    this.rebuild();
    this.syncSelection();
  }

  private applyPhysicsParams(): void {
    const p = this.host.world.params;
    p.gravityY = -Number(this.values.gravity);
    p.restitution = Number(this.values.restitution);
    p.friction = Number(this.values.friction);
    p.ballCollisions = this.values.ballCollisions === true;
    p.killY = -16;
  }

  private rebuild(): void {
    const w = this.host.world;
    w.clearColliders();
    this.colliders.clear();
    for (const el of this.layout.elements) this.colliders.set(el.id, this.makeColliders(el));
    // remove stale touching ids (colliders rebuilt with new ids)
    for (const b of w.balls) b.touching.clear();
  }

  private makeColliders(el: LayoutElement): Collider[] {
    const w = this.host.world;
    const seg = (ax: number, ay: number, bx: number, by: number, thickness: number, o: Partial<Collider>) => w.addCollider({ type: 'segment', ax, ay, bx, by, thickness }, { ...o, userData: el });
    switch (el.kind) {
      case 'ramp':
        return [seg(el.x1, el.y1, el.x2, el.y2, 0.07, { restitution: 0.65, friction: 1, sound: 'mechanical' })];
      case 'wall':
        return [seg(el.x1, el.y1, el.x2, el.y2, 0.14, { restitution: 0.85, friction: 0.6, sound: 'mechanical' })];
      case 'pad':
        return [seg(el.x1, el.y1, el.x2, el.y2, 0.1, { restitution: 1.1, friction: 0.4, sound: 'musical' })];
      case 'gate':
        return [seg(el.x1, el.y1, el.x2, el.y2, 0.03, { sensor: true, sound: 'musical' })];
      case 'bumper':
        return [w.addCollider({ type: 'circle', x: el.x1, y: el.y1, r: el.r }, { restitution: 1, kick: 2.6, friction: 0.2, sound: 'musical', userData: el })];
      case 'funnel': {
        const f = funnelGeom(el);
        return [seg(f.lx, f.ly, f.lbx, f.by, 0.07, { restitution: 0.5, friction: 1, sound: 'mechanical' }), seg(f.rx, f.ry, f.rbx, f.by, 0.07, { restitution: 0.5, friction: 1, sound: 'mechanical' })];
      }
    }
  }

  private rt(id: number): Runtime {
    let r = this.runtime.get(id);
    if (!r) {
      r = { lastHit: -10, seqIndex: 0, lastBall: -1, lastPitch: 60 };
      this.runtime.set(id, r);
    }
    return r;
  }

  private pitchFor(el: LayoutElement, offset = 0): number {
    const m = el.music!;
    const seq = m.sequence ? this.rt(el.id).seqIndex * m.seqStep : 0;
    return degreeToMidi(m.degree + seq + offset, Number(this.values.root), String(this.values.scale), 4);
  }

  private contact(e: ContactEvent): void {
    const pal = this.svc.palette();
    if (e.other) {
      if (e.speed > 3) this.host.mechanical(e.ball, e.speed * 0.6, e.x, 'clack');
      return;
    }
    const el = e.collider?.userData as LayoutElement | null;
    if (!el) return;
    if (!el.music) {
      this.host.mechanical(e.ball, e.speed, e.x, el.kind === 'wall' ? 'thud' : 'tick');
      return;
    }
    const m = el.music;
    if (el.kind !== 'gate' && e.speed < 0.6) return;
    const r = this.rt(el.id);
    if (m.retrigger === 'cooldown' && !this.host.cooldownOk(el.id, m.cooldownMs / 1000)) return;
    if (m.retrigger === 'always' && !this.host.cooldownOk(el.id, 0.03)) return;
    if (m.retrigger === 'mono') {
      if (r.lastBall === e.ball.id && this.host.simTime - r.lastHit < 1.5) return;
      if (!this.host.cooldownOk(el.id, 0.03)) return;
    }
    const impact = clamp(e.speed / 9, 0.08, 1);
    const vel = (1 - m.velSens) * 0.75 + m.velSens * impact;
    const offs = chordDegrees(m.chord as ChordKind, String(this.values.scale));
    let first = 0;
    offs.forEach((o, i) => {
      const p = this.pitchFor(el, o);
      if (i === 0) first = p;
      this.host.playNote(m.instrument, p, vel * (i === 0 ? 1 : 0.7), e.x, 0.5);
    });
    r.lastHit = this.host.simTime;
    r.lastBall = e.ball.id;
    r.lastPitch = first;
    if (m.sequence) r.seqIndex = (r.seqIndex + 1) % Math.max(1, m.seqLength);
    ballVisual(e.ball).flash = 1;
    this.svc.particles.burst(e.x, e.y, pitchColor(pal, first), impact, this.host.simTime, e.nx, e.ny);
  }

  private autoSpawn(dt: number): void {
    const rate = Number(this.values.spawnRate);
    if (rate <= 0) return;
    this.spawnAcc += dt * rate;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      const s = this.layout.spawner;
      const sp = Number(this.values.launchSpeed) * 0.7;
      this.spawnBall(s.x + Math.cos(s.angle) * 0.6, s.y + Math.sin(s.angle) * 0.6, Math.cos(s.angle) * sp, Math.sin(s.angle) * sp);
    }
  }

  private spawnBall(x: number, y: number, vx: number, vy: number): void {
    const r = Number(this.values.ballRadius);
    // safe spawn: nudge upward until the spot is free (bounded attempts)
    let sy = y;
    for (let i = 0; i < 8 && !this.host.world.isFree(x, sy, r); i++) sy += r * 1.2;
    const b = this.host.world.addBall(x, sy, r, vx, vy, this.rng.next());
    ballVisual(b).color = paletteHue(this.svc.palette(), b.hue);
    this.host.enforceCap(Number(this.values.ballCap));
  }

  update(dt: number): void {
    if (this.values.mode === 'edit') return;
    this.host.advance(dt);
  }

  onParam(key: string): void {
    if (key === 'mode') {
      this.drag = null;
      if (this.values.mode === 'play') this.selected = null;
      this.syncSelection();
      this.svc.refreshControls();
      return;
    }
    if (key === 'tool') {
      this.drag = null;
      return;
    }
    if (key === 'preset') {
      this.loadPreset(String(this.values.preset));
      return;
    }
    if (['gravity', 'restitution', 'friction', 'ballCollisions'].includes(key)) {
      this.applyPhysicsParams();
      return;
    }
    if (key === 'ballCap') {
      this.host.enforceCap(Number(this.values.ballCap));
      return;
    }
    if (key === 'clearBalls') {
      this.host.world.clearBalls();
      this.svc.trails.clear();
      return;
    }
    if (key === 'commitLayout') {
      this.baseline = cloneLayout(this.layout);
      this.svc.notify('Current layout is now the starting layout');
      return;
    }
    if (key === 'undo') return this.undo();
    if (key === 'redo') return this.redo();
    if (key === 'delete') return this.deleteSelected();
    if (key === 'duplicate') return this.duplicateSelected();
    if (key.startsWith('sel.')) {
      const el = this.selectedEl();
      if (!el || !el.music) return;
      this.snapshot();
      const m = el.music;
      const v = this.values[key];
      switch (key) {
        case 'sel.degree':
          m.degree = Number(v);
          break;
        case 'sel.instrument':
          m.instrument = v as InstrumentId;
          break;
        case 'sel.velSens':
          m.velSens = Number(v);
          break;
        case 'sel.retrigger':
          m.retrigger = v as Retrigger;
          this.svc.refreshControls();
          break;
        case 'sel.cooldownMs':
          m.cooldownMs = Number(v);
          break;
        case 'sel.chord':
          m.chord = v as ChordKind;
          break;
        case 'sel.sequence':
          m.sequence = v === true;
          this.rt(el.id).seqIndex = 0;
          this.svc.refreshControls();
          break;
        case 'sel.seqStep':
          m.seqStep = Number(v);
          break;
        case 'sel.seqLength':
          m.seqLength = Number(v);
          break;
      }
      // audition the element
      if (this.svc.audio.running && key !== 'sel.cooldownMs' && key !== 'sel.velSens') this.host.playNote(m.instrument, this.pitchFor(el), 0.6, el.x1, 0.4);
    }
  }

  // ---------- editing ----------

  private snapshot(): void {
    const s = JSON.stringify(this.layout);
    if (this.undoStack[this.undoStack.length - 1] === s) return;
    this.undoStack.push(s);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(): void {
    const s = this.undoStack.pop();
    if (!s) return this.svc.notify('Nothing to undo');
    this.redoStack.push(JSON.stringify(this.layout));
    this.layout = JSON.parse(s) as Layout;
    this.afterLayoutChange();
  }

  private redo(): void {
    const s = this.redoStack.pop();
    if (!s) return this.svc.notify('Nothing to redo');
    this.undoStack.push(JSON.stringify(this.layout));
    this.layout = JSON.parse(s) as Layout;
    this.afterLayoutChange();
  }

  private afterLayoutChange(): void {
    if (this.selected !== null && !this.layout.elements.some((e) => e.id === this.selected)) this.selected = null;
    this.rebuild();
    this.syncSelection();
  }

  private selectedEl(): LayoutElement | undefined {
    return this.layout.elements.find((e) => e.id === this.selected);
  }

  private syncSelection(): void {
    const el = this.selectedEl();
    this.values['sel.kind'] = el ? el.kind : '';
    if (el?.music) {
      const m = el.music;
      Object.assign(this.values, {
        'sel.degree': m.degree,
        'sel.instrument': m.instrument,
        'sel.velSens': m.velSens,
        'sel.retrigger': m.retrigger,
        'sel.cooldownMs': m.cooldownMs,
        'sel.chord': m.chord,
        'sel.sequence': m.sequence,
        'sel.seqStep': m.seqStep,
        'sel.seqLength': m.seqLength,
      });
    }
    this.svc.refreshControls();
  }

  private deleteSelected(): void {
    const el = this.selectedEl();
    if (!el) return;
    this.snapshot();
    this.layout.elements = this.layout.elements.filter((e) => e !== el);
    this.selected = null;
    this.afterLayoutChange();
  }

  private duplicateSelected(): void {
    const el = this.selectedEl();
    if (!el) return;
    this.snapshot();
    const copy: LayoutElement = { ...JSON.parse(JSON.stringify(el)), id: this.nextId++ };
    copy.x1 += 0.8;
    copy.x2 += 0.8;
    copy.y1 -= 0.8;
    copy.y2 -= 0.8;
    this.layout.elements.push(copy);
    this.selected = copy.id;
    this.afterLayoutChange();
  }

  private snap(v: number, shift: boolean): number {
    return shift ? v : Math.round(v * 4) / 4;
  }

  private hitElement(x: number, y: number, tol: number): LayoutElement | undefined {
    for (let i = this.layout.elements.length - 1; i >= 0; i--) {
      const el = this.layout.elements[i];
      if (elementDistance(el, x, y) < tol) return el;
    }
    return undefined;
  }

  pointer(p: ScenePointer): boolean {
    this.pointerWorld = { x: p.x, y: p.y };
    const tol = Math.max(0.25, p.pxSize * 14);
    const s = this.layout.spawner;
    if (this.values.mode === 'play') {
      if (p.type === 'down') {
        if (dist(p.x, p.y, s.x, s.y) < Math.max(0.75, p.pxSize * 22)) this.drag = { type: 'aim', x: p.x, y: p.y };
        else this.drag = { type: 'drop', sx: p.x, sy: p.y, x: p.x, y: p.y, moved: false };
        return true;
      }
      if (p.type === 'move') {
        this.hover = dist(p.x, p.y, s.x, s.y) < Math.max(0.75, p.pxSize * 22);
        if (this.drag?.type === 'aim') {
          this.drag.x = p.x;
          this.drag.y = p.y;
        } else if (this.drag?.type === 'drop') {
          if (dist(p.x, p.y, this.drag.sx, this.drag.sy) > p.pxSize * 10) this.drag.moved = true;
        }
        return !!this.drag;
      }
      if (p.type === 'up') {
        const d = this.drag;
        this.drag = null;
        if (d?.type === 'aim') {
          const dx = p.x - s.x;
          const dy = p.y - s.y;
          const l = Math.hypot(dx, dy);
          if (l > 0.3) {
            s.angle = Math.atan2(dy, dx);
            const power = clamp(l / 4, 0.25, 1.5);
            const sp = Number(this.values.launchSpeed) * power;
            this.spawnBall(s.x + (dx / l) * 0.6, s.y + (dy / l) * 0.6, (dx / l) * sp, (dy / l) * sp);
          }
          return true;
        }
        if (d?.type === 'drop' && !d.moved) {
          this.spawnBall(p.x, p.y, 0, 0);
          return true;
        }
        return !!d;
      }
      if (p.type === 'cancel') this.drag = null;
      return false;
    }

    // ---- edit mode ----
    const tool = this.values.tool as Tool;
    if (p.type === 'down') {
      if (tool === 'select') {
        const sel = this.selectedEl();
        if (sel) {
          const h = handleAt(sel, p.x, p.y, tol);
          if (h) {
            this.drag = { type: 'handle', id: sel.id, which: h, snapshot: false };
            return true;
          }
        }
        if (dist(p.x, p.y, s.x, s.y) < Math.max(0.6, tol)) {
          this.drag = { type: 'spawner', ox: p.x - s.x, oy: p.y - s.y, snapshot: false };
          return true;
        }
        const el = this.hitElement(p.x, p.y, tol);
        this.selected = el ? el.id : null;
        this.syncSelection();
        if (el) this.drag = { type: 'move', id: el.id, ox: p.x, oy: p.y, orig: { ...el }, snapshot: false };
        return true;
      }
      const x = this.snap(p.x, p.shift);
      const y = this.snap(p.y, p.shift);
      this.drag = { type: 'place', kind: tool, x1: x, y1: y, x2: x, y2: y };
      return true;
    }
    if (p.type === 'move') {
      const d = this.drag;
      if (!d) return false;
      if (d.type === 'place') {
        d.x2 = this.snap(p.x, p.shift);
        d.y2 = this.snap(p.y, p.shift);
      } else if (d.type === 'move') {
        const el = this.layout.elements.find((e) => e.id === d.id);
        if (!el) return true;
        if (!d.snapshot) {
          this.snapshot();
          d.snapshot = true;
        }
        const dx = this.snap(p.x - d.ox, p.shift);
        const dy = this.snap(p.y - d.oy, p.shift);
        el.x1 = d.orig.x1 + dx;
        el.y1 = d.orig.y1 + dy;
        el.x2 = d.orig.x2 + dx;
        el.y2 = d.orig.y2 + dy;
        this.rebuild();
      } else if (d.type === 'handle') {
        const el = this.layout.elements.find((e) => e.id === d.id);
        if (!el) return true;
        if (!d.snapshot) {
          this.snapshot();
          d.snapshot = true;
        }
        const x = this.snap(p.x, p.shift);
        const y = this.snap(p.y, p.shift);
        if (d.which === 1) {
          el.x1 = x;
          el.y1 = y;
        } else if (d.which === 2) {
          el.x2 = x;
          el.y2 = y;
        } else el.r = clamp(dist(el.x1, el.y1, p.x, p.y), 0.15, el.kind === 'funnel' ? 2 : 3);
        this.rebuild();
      } else if (d.type === 'spawner') {
        if (!d.snapshot) {
          this.snapshot();
          d.snapshot = true;
        }
        s.x = this.snap(p.x - d.ox, p.shift);
        s.y = this.snap(p.y - d.oy, p.shift);
      }
      return true;
    }
    if (p.type === 'up' || p.type === 'cancel') {
      const d = this.drag;
      this.drag = null;
      if (d?.type === 'place' && p.type === 'up') this.placeElement(d);
      return true;
    }
    return false;
  }

  private placeElement(d: Extract<Drag, { type: 'place' }>): void {
    let { x1, y1, x2, y2 } = d;
    const kind = d.kind;
    let r = 0;
    if (kind === 'bumper') {
      r = 0.5;
      x2 = x1;
      y2 = y1;
    } else if (kind === 'funnel') {
      if (dist(x1, y1, x2, y2) < 0.8) {
        x1 -= 2;
        x2 = x1 + 4;
        y2 = y1;
      }
      r = 0.42;
    } else if (dist(x1, y1, x2, y2) < 0.4) {
      const half = kind === 'gate' ? 0.6 : 1.5;
      x2 = x1 + half;
      x1 -= half;
      if (kind === 'ramp') y2 = y1 - 0.6;
      else y2 = y1;
    }
    this.snapshot();
    const music = hasMusic(kind) ? defaultMusic(this.suggestDegree(), kind === 'bumper' ? 'bell' : kind === 'gate' ? 'glass' : 'marimba') : null;
    const el: LayoutElement = { id: this.nextId++, kind, x1, y1, x2, y2, r, music };
    this.layout.elements.push(el);
    this.selected = el.id;
    this.rebuild();
    this.syncSelection();
    if (music && this.svc.audio.running) this.host.playNote(music.instrument, this.pitchFor(el), 0.6, el.x1, 0.4);
  }

  private suggestDegree(): number {
    const used = this.layout.elements.filter((e) => e.music).length;
    return [0, 2, 4, 1, 3, 5, 7, 6][used % 8];
  }

  keydown(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      this.redo();
      return true;
    }
    if (e.key.toLowerCase() === 'e' && !mod) {
      this.values.mode = this.values.mode === 'edit' ? 'play' : 'edit';
      this.onParam('mode');
      return true;
    }
    if (this.values.mode !== 'edit') return false;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.deleteSelected();
      return true;
    }
    if (e.key.toLowerCase() === 'd' && !mod) {
      this.duplicateSelected();
      return true;
    }
    if (e.key === 'Escape' && this.selected !== null) {
      this.selected = null;
      this.syncSelection();
      return true;
    }
    return false;
  }

  bounds() {
    return { minX: -8.6, minY: -10.2, maxX: 8.6, maxY: 11 };
  }

  // ---------- rendering ----------

  render(dl: DrawList, _t: number): void {
    const svc = this.svc;
    const pal = svc.palette();
    const app = svc.appearance();
    const now = this.host.simTime;
    const edit = this.values.mode === 'edit';
    for (const el of this.layout.elements) {
      const r = this.runtime.get(el.id);
      const flash = r && app.highlights ? Math.exp(-(now - r.lastHit) / 0.18) : 0;
      const color: RGB = el.music ? pitchColor(pal, r?.lastPitch ?? this.pitchFor(el)) : el.kind === 'wall' ? pal.structure : pal.track;
      const sel = edit && el.id === this.selected;
      drawElement(dl, el, color, flash, sel);
      if (el.music && app.noteLabels) {
        const p = this.pitchFor(el);
        const lx = el.kind === 'bumper' ? el.x1 : (el.x1 + el.x2) / 2;
        const ly = el.kind === 'bumper' ? el.y1 - el.r - 0.32 : (el.y1 + el.y2) / 2 + 0.38;
        dl.text(noteName(p) + (el.music.chord !== 'none' ? ' ' + el.music.chord : '') + (el.music.sequence ? ' ↻' : ''), lx, ly, 0.3, pal.text, 0.55 + flash * 0.45, 'center');
      }
      if (sel) drawHandles(dl, el, pal.text);
    }
    // launcher
    const s = this.layout.spawner;
    const aimDrag = this.drag?.type === 'aim' ? this.drag : null;
    const ang = aimDrag ? Math.atan2(aimDrag.y - s.y, aimDrag.x - s.x) : s.angle;
    const hot = this.hover || !!aimDrag || (edit && this.drag?.type === 'spawner');
    dl.ring(s.x, s.y, 0.5, 0.06, pal.accent, 0.9, 0.12);
    dl.disc(s.x, s.y, 0.28, pal.accent, hot ? 0.7 : 0.35);
    dl.line(s.x + Math.cos(ang) * 0.55, s.y + Math.sin(ang) * 0.55, s.x + Math.cos(ang) * 0.95, s.y + Math.sin(ang) * 0.95, 0.07, pal.accent, 0.9, 0.08);
    if (aimDrag) {
      const dx = aimDrag.x - s.x;
      const dy = aimDrag.y - s.y;
      const l = Math.hypot(dx, dy);
      if (l > 0.3) {
        const sp = Number(this.values.launchSpeed) * clamp(l / 4, 0.25, 1.5);
        const vx = (dx / l) * sp;
        const vy = (dy / l) * sp;
        const g = -Number(this.values.gravity);
        for (let i = 1; i <= 26; i++) {
          const t = i * 0.045;
          dl.disc(s.x + (dx / l) * 0.6 + vx * t, s.y + (dy / l) * 0.6 + vy * t + 0.5 * g * t * t, 0.05, pal.accent, 0.8 * (1 - i / 28));
        }
      }
    }
    if (this.drag?.type === 'place') {
      const d = this.drag;
      const ghost: LayoutElement = { id: -1, kind: d.kind, x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, r: d.kind === 'bumper' ? 0.5 : 0.42, music: null };
      if (d.kind === 'funnel' && dist(d.x1, d.y1, d.x2, d.y2) < 0.8) {
        ghost.x1 -= 2;
        ghost.x2 = ghost.x1 + 4;
        ghost.y2 = ghost.y1;
      }
      drawElement(dl, ghost, pal.accent, 0, false, 0.5);
    }
    svc.trails.draw(dl, now);
    this.host.drawBalls(dl, now);
    svc.particles.draw(dl, now, clamp(now - this.lastDraw, 0, 0.05));
    this.lastDraw = now;
    if (edit) {
      // edit cursor crosshair at snapped position
      const x = Math.round(this.pointerWorld.x * 4) / 4;
      const y = Math.round(this.pointerWorld.y * 4) / 4;
      dl.disc(x, y, 0.05, pal.dim, 0.6);
    }
  }

  private lastDraw = 0;

  hud(dl: DrawList, _t: number, aspect: number): void {
    const pal = this.svc.palette();
    const edit = this.values.mode === 'edit';
    const msg = edit
      ? `EDIT · ${TOOL_LABEL[this.values.tool as Tool]} · simulation paused`
      : 'PLAY · click to drop · drag the launcher ring to aim & launch';
    const w = dl.textWidth(msg, 0.045);
    dl.rect(0, -0.93, w / 2 + 0.04, 0.04, 0, edit ? pal.accent : pal.bgTop, edit ? 0.25 : 0.55, 0.04, 0, 0, 'hud');
    dl.text(msg, 0, -0.93, 0.045, pal.text, 0.9, 'center', 'hud');
    void aspect;
  }

  stats(): [string, string][] {
    return [
      ['Balls', String(this.host.liveCount)],
      ['Notes', String(this.host.notesPlayed)],
      ['Parts', String(this.layout.elements.length)],
    ];
  }

  loopInfo(): string {
    return 'Free physics sandbox — not a loop. Reset restores the starting layout and seed.';
  }

  dispose(): void {
    this.host.world.clearBalls();
    this.host.world.clearColliders();
  }
}

export function funnelGeom(el: LayoutElement) {
  const lx = Math.min(el.x1, el.x2);
  const rx = Math.max(el.x1, el.x2);
  const ly = el.x1 <= el.x2 ? el.y1 : el.y2;
  const ry = el.x1 <= el.x2 ? el.y2 : el.y1;
  const cx = (lx + rx) / 2;
  const depth = Math.max(0.4, (rx - lx) * 0.45);
  const by = Math.min(ly, ry) - depth;
  const gap = Math.min(el.r, (rx - lx) / 2 - 0.05);
  return { lx, ly, rx, ry, by, lbx: cx - gap, rbx: cx + gap };
}

export function elementDistance(el: LayoutElement, x: number, y: number): number {
  if (el.kind === 'bumper') return Math.max(0, dist(x, y, el.x1, el.y1) - el.r);
  const segD = (ax: number, ay: number, bx: number, by: number) => {
    const t = closestOnSegment(x, y, ax, ay, bx, by);
    return dist(x, y, ax + (bx - ax) * t, ay + (by - ay) * t);
  };
  if (el.kind === 'funnel') {
    const f = funnelGeom(el);
    return Math.min(segD(f.lx, f.ly, f.lbx, f.by), segD(f.rx, f.ry, f.rbx, f.by));
  }
  return segD(el.x1, el.y1, el.x2, el.y2);
}

function handleAt(el: LayoutElement, x: number, y: number, tol: number): 1 | 2 | 'r' | null {
  if (el.kind === 'bumper') return dist(x, y, el.x1 + el.r, el.y1) < tol ? 'r' : null;
  if (dist(x, y, el.x1, el.y1) < tol) return 1;
  if (dist(x, y, el.x2, el.y2) < tol) return 2;
  return null;
}

function drawHandles(dl: DrawList, el: LayoutElement, c: RGB): void {
  if (el.kind === 'bumper') {
    dl.disc(el.x1 + el.r, el.y1, 0.14, c, 0.9, 0.04);
    return;
  }
  dl.disc(el.x1, el.y1, 0.15, c, 0.9, 0.045);
  dl.disc(el.x2, el.y2, 0.15, c, 0.9, 0.045);
}

export function drawElement(dl: DrawList, el: LayoutElement, color: RGB, flash: number, selected: boolean, alpha = 1): void {
  const hi = selected ? 0.25 : 0;
  switch (el.kind) {
    case 'ramp':
      dl.line(el.x1, el.y1, el.x2, el.y2, 0.07, color, 0.9 * alpha, 0.1 + hi, 'main', 1);
      break;
    case 'wall':
      dl.line(el.x1, el.y1, el.x2, el.y2, 0.14, color, 0.75 * alpha, 0.04 + hi, 'main', 0.5);
      break;
    case 'pad':
      dl.line(el.x1, el.y1, el.x2, el.y2, 0.1 + flash * 0.04, color, alpha, 0.14 + flash * 0.25 + hi, 'main', 1);
      if (flash > 0.02) dl.line(el.x1, el.y1, el.x2, el.y2, 0.25, color, flash * 0.5 * alpha, 0, 'glow');
      break;
    case 'gate': {
      dl.disc(el.x1, el.y1, 0.09, color, alpha);
      dl.disc(el.x2, el.y2, 0.09, color, alpha);
      dl.line(el.x1, el.y1, el.x2, el.y2, 0.025 + flash * 0.05, color, (0.45 + flash * 0.55) * alpha, 0.1 + flash * 0.3 + hi, 'main', 1);
      if (flash > 0.02) dl.line(el.x1, el.y1, el.x2, el.y2, 0.2, color, flash * 0.6 * alpha, 0, 'glow');
      break;
    }
    case 'bumper': {
      const r = el.r * (1 + flash * 0.12);
      dl.disc(el.x1, el.y1, r, color, 0.22 * alpha + flash * 0.3);
      dl.ring(el.x1, el.y1, r - 0.05, 0.05, color, alpha, 0.12 + flash * 0.3 + hi);
      dl.disc(el.x1, el.y1, r * 0.35, color, 0.7 * alpha);
      if (flash > 0.02) dl.glow(el.x1, el.y1, r * 2.5, color, flash * 0.6);
      break;
    }
    case 'funnel': {
      const f = funnelGeom(el);
      dl.line(f.lx, f.ly, f.lbx, f.by, 0.07, color, 0.9 * alpha, 0.1 + hi);
      dl.line(f.rx, f.ry, f.rbx, f.by, 0.07, color, 0.9 * alpha, 0.1 + hi);
      break;
    }
  }
}
