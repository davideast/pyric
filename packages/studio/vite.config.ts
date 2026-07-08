import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { NODE_BUILTIN_RE, NODE_BUILTIN_SHIMS } from 'pyric-tools/vite';

/**
 * Studio app build. Outputs static assets to `dist/app`, served by
 * `pyric dev --ui`. The library entry points (`./ports`, `./env`) are emitted
 * separately by `tsc` to `dist/`, kept out of this bundle.
 *
 * `base` is configurable so the packaged build (embedded in pyric-tools and
 * served under `/__pyric/ui/`) can set `STUDIO_BASE=/__pyric/ui/`. The default
 * `/` keeps the dev server and the in-repo review build rooted at `/`.
 */

/**
 * Benign node-builtin shims (`fs`/`path`/`url`) — the SAME shims serve's
 * bundler and the `pyricSandbox` Vite plugin apply to pyric's browser graph.
 * Needed because Studio's bridge peer (clients/bridge-peer.ts) bundles
 * pyric-tools' browser-side bridge client, whose default dispatcher statically
 * reaches the pyric rules module resolver (a Node module the browser path
 * never actually calls into — see pyric-tools' serve/bundler.ts).
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

export default defineConfig({
  base: process.env.STUDIO_BASE ?? '/',
  plugins: [nodeBuiltinShims(), react(), tailwindcss()],
  build: {
    outDir: 'dist/app',
    emptyOutDir: true,
  },
});
