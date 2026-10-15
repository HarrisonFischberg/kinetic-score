// Headless-browser smoke checks against a running static build.
// Usage: node scripts/serve.ts &  then  node scripts/browser-check.ts [baseUrl] [outDir] [steps]
// Requires the `playwright` package and a Chromium build (not a project dependency).
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

async function newPage(width = 1400, height = 900): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(base);
  await page.waitForFunction(() => !!(window as unknown as { kineticScore?: unknown }).kineticScore);
  await page.waitForTimeout(800);
  return page;
}

const state = (page: Page) => page.evaluate(() => (window as unknown as { kineticScore: { debugState(): Record<string, unknown> } }).kineticScore.debugState());

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  if (only && !only.some((o) => name.toLowerCase().includes(o))) return;
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

const page = await newPage();

await check('loads with silent preview and start card', async () => {
  const s = await state(page);
  const overlay = await page.locator('.overlay .card').isVisible();
  await page.screenshot({ path: join(outDir, '01-start.png') });
  if (!overlay) throw new Error('start overlay not visible');
  if (s.audio) throw new Error('audio running before user action');
  return `scene=${s.scene} instances=${s.instances} audio=${s.audio}`;
});

await check('enable audio starts AudioContext', async () => {
  await page.getByRole('button', { name: /Enable audio/ }).click();
  await page.waitForTimeout(700);
  const s = await state(page);
  if (!s.audio) throw new Error('audio not running after click');
  return `audio=${s.audio} playing=${s.playing}`;
});

const toClient = (x: number, y: number) => page.evaluate(([a, b]) => (window as unknown as { kineticScore: { worldToClient(x: number, y: number): { x: number; y: number } } }).kineticScore.worldToClient(a, b), [x, y] as const);
const stat = async (name: string) => {
  const s = await state(page);
  const row = (s.stats as [string, string][]).find((r) => r[0] === name);
  return row ? Number(row[1]) : NaN;
};

await check('builder: click empty space drops a ball', async () => {
  const before = await stat('Balls');
  const p = await toClient(3.5, 9.5);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
  const after = await stat('Balls');
  if (!(after === before + 1)) throw new Error(`balls ${before} -> ${after}`);
  return `balls ${before} -> ${after}`;
});

await check('builder: drag from launcher aims and launches', async () => {
  const before = await stat('Balls');
  const s = await toClient(-6.2, 9.6);
  const t = await toClient(-3.2, 9.0);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.mouse.move((s.x + t.x) / 2, (s.y + t.y) / 2, { steps: 4 });
  await page.mouse.move(t.x, t.y, { steps: 4 });
  await page.screenshot({ path: join(outDir, '02-aim.png') });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const after = await stat('Balls');
  if (!(after === before + 1)) throw new Error(`balls ${before} -> ${after}`);
  return `balls ${before} -> ${after}`;
});

await check('builder: collisions drive notes', async () => {
  for (let i = 0; i < 4; i++) {
    const p = await toClient(-5 + i * 0.4, 8.6);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(3500);
  const notes = await stat('Notes');
  const s = await state(page);
  await page.screenshot({ path: join(outDir, '03-notes.png') });
  if (!(notes > 3)) throw new Error(`only ${notes} notes`);
  return `notes=${notes} voices=${s.voices}`;
});

await check('builder: edit mode places a pad, undo removes it', async () => {
  await page.keyboard.press('e');
  await page.waitForTimeout(100);
  await page.locator('select').filter({ has: page.locator('option[value="pad"]') }).selectOption('pad');
  const parts0 = await stat('Parts');
  const a = await toClient(-3, -3);
  const b = await toClient(1, -4);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const parts1 = await stat('Parts');
  await page.screenshot({ path: join(outDir, '04-edit.png') });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  const parts2 = await stat('Parts');
  await page.keyboard.press('e');
  if (!(parts1 === parts0 + 1 && parts2 === parts0)) throw new Error(`parts ${parts0} -> ${parts1} -> ${parts2}`);
  return `parts ${parts0} -> ${parts1} -> undo ${parts2}`;
});

const sceneIds: string[] = await page.evaluate(() => Array.from(document.querySelectorAll('header select')[0].querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value));
for (const mode of ['playground', 'performance']) {
  await page.getByRole('button', { name: mode === 'playground' ? 'Playground' : 'Performance', exact: true }).click().catch(() => {});
  await page.waitForTimeout(200);
  const ids: string[] = await page.evaluate(() => Array.from((document.querySelectorAll('header select')[0] as HTMLSelectElement).options).map((o) => o.value));
  for (const id of ids) {
    await check(`scene ${id} runs`, async () => {
      await page.selectOption('header select >> nth=0', id);
      await page.waitForTimeout(4000);
      const s = await state(page);
      await page.screenshot({ path: join(outDir, `scene-${id}.png`) });
      if (s.scene !== id) throw new Error(`scene is ${s.scene}`);
      return `pos=${Number(s.position).toFixed(1)} voices=${s.voices} scheduled=${s.scheduled} instances=${s.instances} stats=${JSON.stringify(s.stats)}`;
    });
  }
}
void sceneIds;

writeFileSync(join(outDir, 'results.json'), JSON.stringify({ results, errors }, null, 2));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
console.log(`console errors/warnings: ${errors.length}`);
for (const e of errors.slice(0, 30)) console.log('  ' + e);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
