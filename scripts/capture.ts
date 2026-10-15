// Dev helper: node scripts/capture.ts <sceneId> <t1,t2,...> <outPrefix> [width] [height]
// capture a scene at several transport times (paused) for visual review
import { chromium } from 'playwright';
const [scene, times, out, w, h] = [process.argv[2], process.argv[3].split(',').map(Number), process.argv[4], Number(process.argv[5] ?? 1280), Number(process.argv[6] ?? 800)];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(process.env.BASE ?? 'http://localhost:5180/');
await page.waitForFunction(() => !!(window as any).kineticScore);
await page.waitForTimeout(500);
await page.getByRole('button', { name: 'Continue without sound' }).click();
await page.evaluate((id) => (window as any).kineticScore.switchScene(id), scene);
await page.keyboard.press('h');
for (const t of times) {
  await page.evaluate((tt) => { const a = (window as any).kineticScore; a.debugSeek(tt); }, t);
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${out}-${t}.png` });
}
console.log('errors', errs);
await browser.close();
