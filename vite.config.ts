import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// three.js is vendored (vendor/three, MIT) so the app builds without fetching it.
export default defineConfig({
  base: './',
  resolve: {
    alias: { three: fileURLToPath(new URL('./vendor/three/three.module.js', import.meta.url)) },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
