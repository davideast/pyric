import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Studio app build. Outputs static assets to `dist/app`, served by
 * `pyric serve --ui`. The library entry points (`./ports`, `./env`) are emitted
 * separately by `tsc` to `dist/`, kept out of this bundle.
 *
 * `base` is configurable so the packaged build (embedded in pyric-tools and
 * served under `/__pyric/ui/`) can set `STUDIO_BASE=/__pyric/ui/`. The default
 * `/` keeps the dev server and the in-repo review build rooted at `/`.
 */
export default defineConfig({
  base: process.env.STUDIO_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/app',
    emptyOutDir: true,
  },
});
