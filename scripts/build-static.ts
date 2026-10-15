// Zero-dependency production build: TypeScript → native ES modules + import map.
// Produces dist-static/, a folder you can host on any static web server.
// (The regular `npm run build` uses Vite; this path works without npm packages.)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-static');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const require = createRequire(import.meta.url);
let tsc: string;
try {
  tsc = require.resolve('typescript/bin/tsc');
} catch {
  throw new Error('TypeScript not found: run npm install first.');
}
execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' });

cpSync(join(root, 'src/ui/style.css'), join(out, 'src/ui/style.css'));
cpSync(join(root, 'public'), out, { recursive: true });
mkdirSync(join(out, 'vendor/three'), { recursive: true });
for (const f of ['three.module.js', 'three.core.js', 'LICENSE']) cpSync(join(root, 'vendor/three', f), join(out, 'vendor/three', f));

let html = readFileSync(join(root, 'index.html'), 'utf8');
html = html.replace('<!--IMPORTMAP-->', '<script type="importmap">{ "imports": { "three": "./vendor/three/three.module.js" } }</script>');
html = html.replace('src="./src/main.ts"', 'src="./src/main.js"');
writeFileSync(join(out, 'index.html'), html);
if (!existsSync(join(out, 'src/main.js'))) throw new Error('build failed: main.js missing');
console.log('Static build written to dist-static/');
