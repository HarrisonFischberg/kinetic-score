// Dev helper: let a scene run live and grab screenshots. node scripts/capture-live.ts <sceneId> <seconds,...> <outPrefix> [w] [h] [speed]
import { chromium } from 'playwright';
const [scene, times, out] = [process.argv[2], process.argv[3].split(',').map(Number), process.argv[4]];
const w = Number(process.argv[5] ?? 1280);
const h = Number(process.argv[6] ?? 800);
const speed = process.argv[7] ?? '1';
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(process.env.BASE ?? 'http://localhost:5180/');
await page.waitForFunction(() => !!(window as unknown as { musicalMarbles?: unknown }).musicalMarbles);
await page.getByRole('button', { name: /Enable audio/ }).click();
await page.evaluate(([id, sp]) => {
  const k = (window as unknown as { musicalMarbles: { switchScene(id: string): void; settings: { simSpeed: number } } }).musicalMarbles;
  k.settings.simSpeed = Number(sp);
  k.switchScene(id);
}, [scene, speed]);
await page.keyboard.press('h');
let elapsed = 0;
for (const t of times) {
  await page.waitForTimeout((t - elapsed) * 1000);
  elapsed = t;
  await page.screenshot({ path: `${out}-${t}.png` });
}
console.log('errors', errs);
await browser.close();
