// Versioned settings + project schema with defensive validation. Imported JSON is
// only ever parsed and checked field-by-field; nothing is executed or eval'd.
import { legacyKeys, schemaIs } from '../core/schema.ts';
import { INSTRUMENTS, type InstrumentId } from '../audio/instruments.ts';
import { defaultAppearance, type Appearance, type ParamValue } from '../scenes/types.ts';
import { PALETTES } from '../rendering/palette.ts';
import { validateLayout, type Layout } from '../scenes/builder/layout.ts';

export type AspectId = 'portrait' | 'square' | 'landscape';
export type ResId = 'hd' | 'fhd';

export interface ExportSettings {
  aspect: AspectId;
  /** letterbox the live preview to the export frame (always on while recording) */
  framePreview: boolean;
  mode: 'manual' | 'timed' | 'performance' | 'loop';
  timedSeconds: number;
  res: ResId;
  fps: 30 | 60;
  countdown: boolean;
  dprCap: number;
  tail: number;
}

export interface AudioSettings {
  master: number;
  muted: boolean;
  ambience: boolean;
  mech: number;
  inst: Record<InstrumentId, number>;
}

export interface AppSettings {
  schema: 'musical-marbles/settings@1';
  seed: number;
  appearance: Appearance;
  audio: AudioSettings;
  export: ExportSettings;
  simSpeed: number;
  lastScene: string;
  sceneValues: Record<string, Record<string, ParamValue>>;
  layout: Layout | null;
}

export interface Project {
  schema: 'musical-marbles/project@1';
  name: string;
  savedAt: string;
  sceneId: string;
  settings: AppSettings;
}

export const EXPORT_SIZES: Record<AspectId, Record<ResId, [number, number]>> = {
  portrait: { hd: [720, 1280], fhd: [1080, 1920] },
  square: { hd: [720, 720], fhd: [1080, 1080] },
  landscape: { hd: [1280, 720], fhd: [1920, 1080] },
};

export function defaultSettings(): AppSettings {
  const inst = {} as Record<InstrumentId, number>;
  for (const i of INSTRUMENTS) inst[i.id] = 0.8;
  return {
    schema: 'musical-marbles/settings@1',
    seed: 20240917,
    appearance: defaultAppearance(),
    audio: { master: 0.8, muted: false, ambience: true, mech: 0.35, inst },
    export: { aspect: 'landscape', framePreview: false, mode: 'manual', timedSeconds: 20, res: 'hd', fps: 30, countdown: true, dprCap: 2, tail: 2.5 },
    simSpeed: 1,
    lastScene: 'rain',
    sceneValues: {},
    layout: null,
  };
}

const isNum = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/**
 * Merge untrusted settings onto defaults. Unknown or invalid fields are dropped
 * and reported in `warnings`; a non-object or wrong schema is an error.
 */
export function sanitizeSettings(raw: unknown): { settings: AppSettings; warnings: string[]; errors: string[] } {
  const s = defaultSettings();
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { settings: s, warnings, errors: ['Settings must be a JSON object.'] };
  const r = raw as Record<string, unknown>;
  if (!schemaIs(r.schema, 'settings')) return { settings: s, warnings, errors: ['Unsupported settings schema (expected musical-marbles/settings@1).'] };
  if (isNum(r.seed, 0, 0xffffffff)) s.seed = Math.floor(r.seed);
  else if (r.seed !== undefined) warnings.push('seed ignored');
  if (isNum(r.simSpeed, 0.1, 4)) s.simSpeed = r.simSpeed;
  if (typeof r.lastScene === 'string' && r.lastScene.length < 40) s.lastScene = r.lastScene;
  const a = r.appearance as Record<string, unknown> | undefined;
  if (a && typeof a === 'object') {
    const d = s.appearance;
    if (typeof a.palette === 'string' && PALETTES.some((p) => p.id === a.palette)) d.palette = a.palette;
    if (isNum(a.glow, 0, 2)) d.glow = a.glow;
    if (isNum(a.trailLength, 0.05, 3)) d.trailLength = a.trailLength;
    if (isNum(a.particleDensity, 0, 3)) d.particleDensity = a.particleDensity;
    if (isNum(a.grid, 0, 2)) d.grid = a.grid;
    for (const k of ['trails', 'particles', 'noteLabels', 'highlights', 'showTitle', 'showCounters'] as const) if (typeof a[k] === 'boolean') d[k] = a[k] as boolean;
  }
  const au = r.audio as Record<string, unknown> | undefined;
  if (au && typeof au === 'object') {
    if (isNum(au.master, 0, 1)) s.audio.master = au.master;
    if (typeof au.muted === 'boolean') s.audio.muted = au.muted;
    if (typeof au.ambience === 'boolean') s.audio.ambience = au.ambience;
    if (isNum(au.mech, 0, 1)) s.audio.mech = au.mech;
    const inst = au.inst as Record<string, unknown> | undefined;
    if (inst && typeof inst === 'object') for (const i of INSTRUMENTS) if (isNum(inst[i.id], 0, 1)) s.audio.inst[i.id] = inst[i.id] as number;
  }
  const ex = r.export as Record<string, unknown> | undefined;
  if (ex && typeof ex === 'object') {
    if (['portrait', 'square', 'landscape'].includes(ex.aspect as string)) s.export.aspect = ex.aspect as AspectId;
    if (typeof ex.framePreview === 'boolean') s.export.framePreview = ex.framePreview;
    if (ex.mode === 'manual' || ex.mode === 'timed' || ex.mode === 'performance' || ex.mode === 'loop') s.export.mode = ex.mode;
    if (isNum(ex.timedSeconds, 1, 600)) s.export.timedSeconds = ex.timedSeconds;
    if (ex.res === 'hd' || ex.res === 'fhd') s.export.res = ex.res;
    if (ex.fps === 30 || ex.fps === 60) s.export.fps = ex.fps;
    if (typeof ex.countdown === 'boolean') s.export.countdown = ex.countdown;
    if (isNum(ex.dprCap, 0.5, 3)) s.export.dprCap = ex.dprCap;
    if (isNum(ex.tail, 0, 10)) s.export.tail = ex.tail;
  }
  const sv = r.sceneValues as Record<string, unknown> | undefined;
  if (sv && typeof sv === 'object') {
    for (const [scene, vals] of Object.entries(sv).slice(0, 40)) {
      if (!/^[a-z0-9-]{1,40}$/.test(scene) || !vals || typeof vals !== 'object') continue;
      const out: Record<string, ParamValue> = {};
      for (const [k, v] of Object.entries(vals as Record<string, unknown>).slice(0, 80)) {
        if (k.length > 40) continue;
        if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || (typeof v === 'string' && v.length < 60)) out[k] = v;
      }
      s.sceneValues[scene] = out;
    }
  }
  if (r.layout !== undefined && r.layout !== null) {
    const errs = validateLayout(r.layout);
    if (errs.length) warnings.push(`Builder layout ignored: ${errs[0]}`);
    else s.layout = { ...(r.layout as Layout), schema: 'musical-marbles/layout@1' };
  }
  return { settings: s, warnings, errors };
}

export function validateProject(raw: unknown): { project: Project | null; errors: string[]; warnings: string[] } {
  if (!raw || typeof raw !== 'object') return { project: null, errors: ['Project must be a JSON object.'], warnings: [] };
  const r = raw as Record<string, unknown>;
  if (!schemaIs(r.schema, 'project')) return { project: null, errors: ['Not a Musical Marbles project (schema must be musical-marbles/project@1).'], warnings: [] };
  if (typeof r.sceneId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(r.sceneId)) return { project: null, errors: ['sceneId is missing or invalid.'], warnings: [] };
  const { settings, warnings, errors } = sanitizeSettings(r.settings);
  if (errors.length) return { project: null, errors, warnings };
  return {
    project: { schema: 'musical-marbles/project@1', name: typeof r.name === 'string' ? r.name.slice(0, 80) : 'Untitled', savedAt: typeof r.savedAt === 'string' ? r.savedAt.slice(0, 40) : '', sceneId: r.sceneId, settings },
    errors: [],
    warnings,
  };
}

// ---- storage (all access guarded: private mode / quota / disabled storage) ----

const KEY = 'musical-marbles/settings@1';
const SLOTS = 'musical-marbles/projects@1';

/** read a storage key, migrating a value saved under the app's former name */
function readKey(key: string): string | null {
  const v = localStorage.getItem(key);
  if (v !== null) return v;
  for (const old of legacyKeys(key)) {
    const o = localStorage.getItem(old);
    if (o === null) continue;
    try {
      localStorage.setItem(key, o);
    } catch {
      /* quota: still use the old value this time */
    }
    return o;
  }
  return null;
}

export function storageAvailable(): boolean {
  try {
    const k = '__ks_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

export function loadSettings(): { settings: AppSettings; warnings: string[] } {
  try {
    const txt = readKey(KEY);
    if (!txt) return { settings: defaultSettings(), warnings: [] };
    const { settings, warnings, errors } = sanitizeSettings(JSON.parse(txt));
    return { settings, warnings: [...errors, ...warnings] };
  } catch {
    return { settings: defaultSettings(), warnings: ['Saved settings could not be read; defaults restored.'] };
  }
}

export function saveSettings(s: AppSettings): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

export function listProjects(): Project[] {
  try {
    const arr = JSON.parse(readKey(SLOTS) ?? '[]') as unknown[];
    if (!Array.isArray(arr)) return [];
    return arr.map((p) => validateProject(p).project).filter((p): p is Project => !!p);
  } catch {
    return [];
  }
}

export function saveProject(p: Project): string | null {
  try {
    const list = listProjects().filter((x) => x.name !== p.name);
    list.unshift(p);
    localStorage.setItem(SLOTS, JSON.stringify(list.slice(0, 20)));
    return null;
  } catch (e) {
    return e instanceof Error && e.name === 'QuotaExceededError' ? 'Browser storage is full.' : 'Browser storage is unavailable (private mode or disabled).';
  }
}

export function deleteProject(name: string): void {
  try {
    localStorage.setItem(SLOTS, JSON.stringify(listProjects().filter((x) => x.name !== name)));
  } catch {
    /* ignore */
  }
}
