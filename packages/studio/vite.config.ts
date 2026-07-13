import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {
  NODE_BUILTIN_RE,
  NODE_BUILTIN_SHIMS,
  pyricSandbox,
  type PyricSandboxOptions,
} from '@pyric/cli/vite';

/**
 * Studio app build. Outputs static assets to `dist/app`, served by
 * `pyric dev --ui`. The library entry points (`./ports`, `./env`) are emitted
 * separately by `tsc` to `dist/`, kept out of this bundle.
 *
 * `base` is configurable so the packaged build (embedded in @pyric/cli and
 * served under `/__pyric/ui/`) can set `STUDIO_BASE=/__pyric/ui/`. The default
 * `/` keeps the dev server and the in-repo review build rooted at `/`.
 *
 * `STUDIO_STATIC=1` (the composed static-site build, `scripts/build-site.sh`)
 * bakes `import.meta.env.STUDIO_STATIC = true` into the bundle via `define` —
 * `env.ts` reads it to skip the HTTP project/persistence clients (no pyric
 * devr exists under static hosting). `define` performs a literal text
 * substitution, so this only affects `import.meta.env.STUDIO_STATIC`
 * expressions bundled into THIS app; the `dist/env.js` library export (built
 * by plain `tsc`, consumed under Node/Bun) is untouched and reads `undefined`
 * there — see `env.ts`'s `typeof import.meta.env !== 'undefined'` guard.
 */

/**
 * Benign node-builtin shims (`fs`/`path`/`url`) — the SAME shims serve's
 * bundler and the `pyricSandbox` Vite plugin apply to pyric's browser graph.
 * Needed because Studio's bridge peer (clients/bridge-peer.ts) bundles
 * @pyric/cli' browser-side bridge client, whose default dispatcher statically
 * reaches the pyric rules module resolver (a Node module the browser path
 * never actually calls into — see @pyric/cli' serve/bundler.ts).
 */
function nodeBuiltinShims(): Plugin {
  const PREFIX = '\0pyric-node-shim:';
  return {
    name: 'studio-node-builtin-shims',
    enforce: 'pre',
    resolveId(source) {
      const m = NODE_BUILTIN_RE.exec(source);
      return m ? PREFIX + m[2]! : null;
    },
    load(id) {
      return id.startsWith(PREFIX) ? NODE_BUILTIN_SHIMS[id.slice(PREFIX.length)] : null;
    },
  };
}

export const studioSandboxOptions = {
  ui: true,
  capture: false,
} satisfies PyricSandboxOptions;

export default defineConfig({
  base: process.env.STUDIO_BASE ?? '/',
  plugins: [
    // `bun run dev` serves Studio directly, outside `pyric dev`. Mount the
    // runtime namespace here so the SharedWorker URL cannot fall through to
    // Vite's Studio index.html response. Review sessions should still avoid
    // writing capture files.
    pyricSandbox(studioSandboxOptions),
    nodeBuiltinShims(),
    react(),
    tailwindcss(),
  ],
  define: {
    'import.meta.env.STUDIO_STATIC': JSON.stringify(process.env.STUDIO_STATIC === '1'),
  },
  build: {
    outDir: 'dist/app',
    emptyOutDir: true,
  },
});
