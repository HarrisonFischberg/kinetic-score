import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// three.js is vendored (vendor/three, MIT) so the app builds without fetching it.
export default defineConfig({
  base: './',
  resolve: {
    alias: { three: fileURLToPath(new URL('./vendor/three/three.module.js', import.meta.url)) },
  },
  plugins: [
    {
      // the placeholder is only used by the zero-dependency build (scripts/build-static.ts)
      name: 'strip-importmap-placeholder',
      transformIndexHtml: (html) => html.replace('<!--IMPORTMAP-->', ''),
    },
  ],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
