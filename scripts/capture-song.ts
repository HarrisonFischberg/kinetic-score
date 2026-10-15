// Dev helper: node scripts/capture-song.ts <sceneId> <songId> <t1,t2> <outPrefix> [w] [h]
import { chromium } from 'playwright';
const [scene, song, times, out] = [process.argv[2], process.argv[3], process.argv[4].split(',').map(Number), process.argv[5]];
const w = Number(process.argv[6] ?? 1280);
const h = Number(process.argv[7] ?? 800);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(process.env.BASE ?? 'http://localhost:5180/');
await page.waitForFunction(() => !!(window as unknown as { kineticScore?: unknown }).kineticScore);
await page.getByRole('button', { name: 'Continue without sound' }).click();
await page.evaluate(([id, sg]) => {
  const k = (window as unknown as { kineticScore: Record<string, (...a: unknown[]) => unknown> }).kineticScore;
  k.switchScene(id);
  k.setSceneParam('song', sg);
}, [scene, song]);
await page.keyboard.press('h');
for (const t of times) {
  await page.evaluate((tt) => (window as unknown as { kineticScore: { debugSeek(t: number): void } }).kineticScore.debugSeek(tt), t);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}-${t}.png` });
}
console.log('errors', errs);
await browser.close();
