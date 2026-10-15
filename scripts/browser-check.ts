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

writeFileSync(join(outDir, 'results.json'), JSON.stringify({ results, errors }, null, 2));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
console.log(`console errors/warnings: ${errors.length}`);
for (const e of errors.slice(0, 30)) console.log('  ' + e);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
