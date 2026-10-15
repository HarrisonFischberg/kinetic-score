// Headless-browser checks against a running static build (or `vite preview`).
// Usage: node scripts/serve.ts &   then   node scripts/browser-check.ts [baseUrl] [outDir] [filter]
// Requires the `playwright` package and a Chromium build (not a project dependency).
// Chromium runs with SwiftShader (software WebGL) and a fake audio output, so this checks
// behaviour, not how things look on real hardware or sound through real speakers.
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://localhost:5180/';
const outDir = process.argv[3] ?? 'build/browser-check';
const only = process.argv[4]?.split(',');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const results: { name: string; ok: boolean; detail: string }[] = [];
const errors: string[] = [];

/** run code against window.kineticScore inside the page */
async function ks<T>(page: Page, body: string, arg?: unknown): Promise<T> {
  return page.evaluate(([b, a]) => new Function('k', 'a', b)((window as unknown as { kineticScore: unknown }).kineticScore, a), [body, arg] as const) as Promise<T>;
}

async function newPage(width = 1400, height = 900, clearStorage = true, sameContextAs?: Page): Promise<Page> {
  const ctx = sameContextAs ? sameContextAs.context() : await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[error] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(base);
  if (clearStorage) {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  }
  await page.waitForFunction(() => !!(window as unknown as { kineticScore?: unknown }).kineticScore);
  await page.waitForTimeout(800);
  return page;
}

const state = (page: Page) => ks<Record<string, unknown>>(page, 'return k.debugState()');
const stat = async (page: Page, name: string) => {
  const s = await state(page);
  const row = (s.stats as [string, string][]).find((r) => r[0] === name);
  return row ? parseFloat(row[1]) : NaN;
};
const toClient = (page: Page, x: number, y: number) => ks<{ x: number; y: number }>(page, 'return k.worldToClient(a[0], a[1])', [x, y]);

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  if (only && !only.some((o) => name.toLowerCase().includes(o))) return;
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name} — ${detail}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message.split('\n')[0] : String(e);
    results.push({ name, ok: false, detail });
    console.log(`FAIL  ${name} — ${detail}`);
  }
}

const page = await newPage();

await check('loads with a silent preview and the start card', async () => {
  const s = await state(page);
  await page.screenshot({ path: join(outDir, '01-start.png') });
  if (!(await page.locator('.overlay .card').isVisible())) throw new Error('start overlay not visible');
  if (s.audio) throw new Error('audio running before user action');
  if (!s.playing) throw new Error('preview is not animating');
  return `scene=${s.scene} audio=${s.audio} playing=${s.playing}`;
});

await check('enable audio starts the AudioContext only after the click', async () => {
  await page.getByRole('button', { name: /Enable audio/ }).click();
  await page.waitForTimeout(800);
  const s = await state(page);
  if (!s.audio) throw new Error('audio not running after click');
  return `audio=${s.audio} scene=${s.scene}`;
});

await check('performance: scheduled audio events equal the activations that are due', async () => {
  await ks(page, "k.switchScene('canon')");
  await page.waitForTimeout(9000);
  const r = await ks<{ scheduled: number; due: number; pos: number; voices: number }>(
    page,
    `const st = k.debugState(); const perf = k.debugScene().performance(); const pos = st.position;
     return { scheduled: st.scheduled, due: perf.events.filter((e) => e.time < pos + 0.15).length, pos, voices: st.voices };`,
  );
  await page.screenshot({ path: join(outDir, '02-canon.png') });
  if (r.due <= 0) throw new Error('no events were due');
  if (Math.abs(r.scheduled - r.due) > 2) throw new Error(`scheduled ${r.scheduled} vs due ${r.due}`);
  return `t=${r.pos.toFixed(1)}s scheduled=${r.scheduled} due=${r.due} voices=${r.voices}`;
});

await check('pause holds the transport; restart (R) returns to the start', async () => {
  await page.locator('canvas').focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  const p1 = await state(page);
  await page.waitForTimeout(600);
  const p2 = await state(page);
  if (p1.playing || p1.position !== p2.position) throw new Error('transport kept moving while paused');
  await page.keyboard.press('r');
  await page.waitForTimeout(300);
  const s = await state(page);
  if (!(s.playing && (s.position as number) < 1)) throw new Error(`after restart pos=${s.position}`);
  return `paused at ${(p1.position as number).toFixed(2)} s (stable); restart → ${(s.position as number).toFixed(2)} s`;
});

await check('builder: click drops, launcher drag launches, contacts make notes, edit + undo', async () => {
  await ks(page, "k.switchScene('builder')");
  await page.waitForTimeout(400);
  const b0 = await stat(page, 'Balls');
  const p = await toClient(page, 3.5, 9.5);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(100);
  const b1 = await stat(page, 'Balls');
  const s0 = await toClient(page, -6.2, 9.6);
  const t0 = await toClient(page, -3.2, 9.0);
  await page.mouse.move(s0.x, s0.y);
  await page.mouse.down();
  await page.mouse.move(t0.x, t0.y, { steps: 6 });
  await page.screenshot({ path: join(outDir, '03-aim.png') });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const b2 = await stat(page, 'Balls');
  for (let i = 0; i < 4; i++) {
    const q = await toClient(page, -5 + i * 0.4, 8.6);
    await page.mouse.click(q.x, q.y);
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(3500);
  const notes = await stat(page, 'Notes');
  await page.keyboard.press('e');
  await page.waitForTimeout(150);
  await page.locator('select').filter({ has: page.locator('option[value="pad"]') }).selectOption('pad');
  const parts0 = await stat(page, 'Parts');
  const a = await toClient(page, -3, -3);
  const z = await toClient(page, 1, -4);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(z.x, z.y, { steps: 5 });
  await page.mouse.up();
  const parts1 = await stat(page, 'Parts');
  await page.screenshot({ path: join(outDir, '04-edit.png') });
  await page.locator('canvas').focus();
  await page.keyboard.press('Control+z');
  const parts2 = await stat(page, 'Parts');
  await page.keyboard.press('e');
  if (b1 !== b0 + 1 || b2 !== b1 + 1) throw new Error(`balls ${b0}→${b1}→${b2}`);
  if (!(notes > 3)) throw new Error(`notes=${notes}`);
  if (!(parts1 === parts0 + 1 && parts2 === parts0)) throw new Error(`parts ${parts0}→${parts1}→${parts2}`);
  return `balls ${b0}→${b1}→${b2}, notes=${notes}, parts ${parts0}→${parts1}→undo ${parts2}`;
});

await check('cascade: population never exceeds the cap', async () => {
  await ks(page, "k.switchScene('cascade'); const s = k.debugScene(); Object.assign(s.values, { cap: 12, ballSpawn: 1, wallSpawn: 1, cooldown: 0.1 });");
  let max = 0;
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(500);
    max = Math.max(max, await stat(page, 'Balls'));
  }
  const spawned = await stat(page, 'Spawned');
  await page.screenshot({ path: join(outDir, '05-cascade.png') });
  if (max > 12) throw new Error(`population reached ${max}`);
  if (!(spawned > 2)) throw new Error(`only ${spawned} spawned`);
  return `max live=${max} (cap 12), spawned=${spawned}`;
});

await check('growing ball: size stays within the limit', async () => {
  await ks(page, "k.switchScene('growing'); k.debugScene().values.growth = 0.12;");
  let max = 0;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(500);
    max = Math.max(max, await stat(page, 'Size'));
  }
  if (!(max <= 100)) throw new Error(`size ${max}%`);
  return `max size ${max}% of the limit`;
});

await check('shepard lab: direction control reverses the phase', async () => {
  await ks(page, "k.switchScene('shepard')");
  await page.waitForTimeout(1500);
  const t1 = await stat(page, 'Turns');
  await page.waitForTimeout(1200);
  const t2 = await stat(page, 'Turns');
  await ks(page, "const s = k.debugScene(); s.values.direction = 'down'; s.onParam('direction');");
  await page.waitForTimeout(1000);
  const t3 = await stat(page, 'Turns');
  await page.waitForTimeout(1200);
  const t4 = await stat(page, 'Turns');
  await page.screenshot({ path: join(outDir, '06-shepard.png') });
  if (!(t2 > t1 && t4 < t3)) throw new Error(`turns ${t1} ${t2} ${t3} ${t4}`);
  return `rising ${t1}→${t2}, falling ${t3}→${t4}`;
});

await check('sequencer: timeline wraps seamlessly at the end', async () => {
  await ks(page, "k.switchScene('sequencer')");
  await page.waitForTimeout(500);
  const dur = await ks<number>(page, 'return k.debugScene().performance().duration');
  await ks(page, 'k.debugSeek(a - 0.5)', dur);
  await page.locator('canvas').focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(2000);
  const s = await state(page);
  if (!(s.playing && (s.position as number) < 3)) throw new Error(`position ${s.position} after wrap`);
  return `timeline ${dur.toFixed(1)} s → wrapped to ${(s.position as number).toFixed(2)} s`;
});

const recordBody = `
  const opts = a;
  Object.assign(k.settings.export, opts);
  const first = k.recorder.last ? k.recorder.last.url : null;
  await k.toggleRecord();
  const t0 = performance.now();
  while (performance.now() - t0 < 15000) {
    await new Promise((res) => setTimeout(res, 250));
    const rec = k.recorder.last;
    if (rec && rec.url !== first) {
      const v = document.createElement('video');
      v.muted = true;
      v.src = rec.url;
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('video failed to load')); });
      await v.play().catch(() => {});
      await new Promise((res) => setTimeout(res, 1500));
      return { mime: rec.mime, ext: rec.ext, filename: rec.filename, w: v.videoWidth, h: v.videoHeight, size: rec.blob.size, hasAudio: rec.hasAudio,
        audioBytes: v.webkitAudioDecodedByteCount ?? -1, videoBytes: v.webkitVideoDecodedByteCount ?? -1, pixel: k.debugState().pixel };
    }
  }
  return null;`;

type RecResult = { mime: string; ext: string; filename: string; w: number; h: number; size: number; hasAudio: boolean; audioBytes: number; videoBytes: number; pixel: number[] } | null;

await check('recording: timed take is a playable video with audio, exact size, matching extension', async () => {
  await ks(page, "k.switchScene('rain')");
  await page.waitForTimeout(500);
  const r = await ks<RecResult>(page, `return (async () => {${recordBody}})()`, { aspect: 'portrait', res: 'hd', fps: 30, countdown: false, mode: 'timed', timedSeconds: 3 });
  if (!r) throw new Error('no recording result');
  await page.screenshot({ path: join(outDir, '07-recorded.png') });
  const extOk = (r.mime.startsWith('video/webm') && r.ext === 'webm' && r.filename.endsWith('.webm')) || (r.mime.startsWith('video/mp4') && r.ext === 'mp4' && r.filename.endsWith('.mp4'));
  if (!extOk) throw new Error(`mime/extension mismatch ${r.mime} ${r.filename}`);
  if (r.w !== 720 || r.h !== 1280) throw new Error(`video is ${r.w}x${r.h}`);
  if (!r.hasAudio || !(r.audioBytes > 0)) throw new Error(`no decodable audio (bytes=${r.audioBytes})`);
  if (r.pixel[0] === 720 && r.pixel[1] === 1280) throw new Error('preview size was not restored');
  return `${r.filename} · ${r.mime} · ${r.w}×${r.h} · ${(r.size / 1e3).toFixed(0)} kB · audio decoded ${r.audioBytes} B · preview back to ${r.pixel.join('×')}`;
});

await check('recording: a second take works (square)', async () => {
  const r = await ks<RecResult>(page, `return (async () => {${recordBody}})()`, { aspect: 'square', res: 'hd', countdown: false, mode: 'timed', timedSeconds: 2 });
  if (!r) throw new Error('second recording did not finish');
  if (r.w !== 720 || r.h !== 720) throw new Error(`second take ${r.w}x${r.h}`);
  return `${r.filename} ${r.w}×${r.h}`;
});

await check('recording: "whole performance" take starts from the top and stops itself', async () => {
  // Ode to Joy in Melody Rain is ~40 s: shorten by running at a faster tempo
  await ks(page, "k.switchScene('rain'); const s = k.debugScene(); s.values.song = 'ode-to-joy'; s.values.tempo = 1.4; k.restart();");
  const r = await ks<{ started: number; stoppedAfter: number; w: number; h: number } | null>(
    page,
    `return (async () => {
      Object.assign(k.settings.export, { aspect: 'landscape', res: 'hd', countdown: false, mode: 'performance', tail: 1 });
      const first = k.recorder.last ? k.recorder.last.url : null;
      await k.toggleRecord();
      const started = k.debugState().position;
      const t0 = performance.now();
      while (performance.now() - t0 < 60000) {
        await new Promise((res) => setTimeout(res, 500));
        const rec = k.recorder.last;
        if (rec && rec.url !== first) return { started, stoppedAfter: rec.seconds, w: rec.width, h: rec.height };
      }
      return null;
    })()`,
  );
  if (!r) throw new Error('performance take did not stop on its own');
  if (r.started > 0.5) throw new Error(`take started at ${r.started}`);
  return `started at ${r.started.toFixed(2)} s, auto-stopped after ${r.stoppedAfter.toFixed(1)} s, ${r.w}×${r.h}`;
});

await check('screenshot downloads a PNG', async () => {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.getByRole('button', { name: 'Screenshot', exact: true }).click()]);
  const name = dl.suggestedFilename();
  if (!name.endsWith('.png')) throw new Error(name);
  return name;
});

await check('clean view hides controls and Esc restores them', async () => {
  await page.getByRole('button', { name: 'Clean view' }).click();
  await page.waitForTimeout(300);
  const hidden = !(await page.locator('header').isVisible());
  await page.screenshot({ path: join(outDir, '08-clean.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const shown = await page.locator('header').isVisible();
  if (!hidden || !shown) throw new Error(`hidden=${hidden} shown=${shown}`);
  return 'header hidden in clean view, back after Esc';
});

await check('persistence: a saved project survives a reload and loads back', async () => {
  await ks(page, "k.switchScene('maze'); k.settings.appearance.palette = 'ember'; k.saveProjectAs('Browser check');");
  await page.waitForTimeout(600);
  // a fresh page in the same browser profile = a reload with the same localStorage
  const p2 = await newPage(1400, 900, false, page);
  const r = await ks<{ found: boolean; palette: string; scene: string }>(
    p2,
    `const list = JSON.parse(localStorage.getItem('kinetic-score/projects@1') || '[]');
     const proj = list.find((p) => p.name === 'Browser check');
     if (proj) k.loadProject(proj);
     return { found: !!proj, palette: k.settings.appearance.palette, scene: k.debugState().scene };`,
  );
  await p2.close();
  if (!r.found || r.palette !== 'ember' || r.scene !== 'maze') throw new Error(JSON.stringify(r));
  return `found=${r.found} palette=${r.palette} scene=${r.scene}`;
});

await check('score import: validated JSON becomes a playable song; hostile JSON is rejected', async () => {
  const ode = await page.evaluate(async () => (await fetch('./scores/ode-to-joy.json')).json());
  const r = await ks<{ ok: string; bad: string; song: unknown; scene: unknown }>(
    page,
    `k.switchScene('rain');
     const msg = document.createElement('p');
     k.importScore(JSON.stringify({ ...a, notes: [{ t: 0, d: 1, p: 999, v: 1, voice: 'x' }] }), msg);
     const bad = msg.textContent;
     const custom = { ...a, id: 'my-ode', title: 'My Ode (imported)' };
     k.importScore(JSON.stringify(custom), msg);
     return { ok: msg.className, bad, song: k.debugScene().values.song, scene: k.debugState().scene };`,
    ode,
  );
  if (!String(r.bad).includes('rejected')) throw new Error(`bad score not rejected: ${r.bad}`);
  if (r.song !== 'import-my-ode') throw new Error(`song is ${r.song}`);
  return `rejected: "${String(r.bad).slice(0, 60)}…"; imported → song=${r.song} in ${r.scene}`;
});

await check('mobile portrait layout: no horizontal scroll, canvas visible, touch-safe', async () => {
  const m = await newPage(390, 844);
  await m.getByRole('button', { name: 'Continue without sound' }).click();
  await m.waitForTimeout(800);
  const r = await m.evaluate(() => {
    const cv = document.querySelector('canvas')!;
    const c = cv.getBoundingClientRect();
    return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, canvasW: Math.round(c.width), canvasH: Math.round(c.height), touch: getComputedStyle(cv).touchAction };
  });
  await m.screenshot({ path: join(outDir, '09-mobile.png') });
  await m.close();
  if (r.scrollW > r.innerW + 1) throw new Error(`horizontal overflow ${r.scrollW} > ${r.innerW}`);
  if (r.canvasH < 200 || r.touch !== 'none') throw new Error(JSON.stringify(r));
  return JSON.stringify(r);
});

for (const id of ['canon', 'rain', 'maze', 'orbital', 'rings', 'builder', 'growing', 'cascade', 'sequencer', 'shepard']) {
  await check(`scene ${id} renders without errors`, async () => {
    await ks(page, 'k.switchScene(a)', id);
    await page.waitForTimeout(2500);
    const s = await state(page);
    await page.screenshot({ path: join(outDir, `scene-${id}.png`) });
    if (s.scene !== id) throw new Error(`scene is ${s.scene}`);
    if (!((s.instances as number) > 10)) throw new Error('nothing drawn');
    return `instances=${s.instances} voices=${s.voices}`;
  });
}

writeFileSync(join(outDir, 'results.json'), JSON.stringify({ results, errors }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed; console errors: ${errors.length}`);
for (const e of errors.slice(0, 30)) console.log('  ' + e);
await browser.close();
process.exit(results.every((r) => r.ok) && errors.length === 0 ? 0 : 1);
