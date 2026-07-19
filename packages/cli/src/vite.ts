/**
 * `@pyric/cli/vite` — the dev-only Vite plugin that swaps `firebase/*` to the
 * in-process pyric sandbox during `vite dev` (the serve analog for source-driven
 * apps). See `./serve/vite-plugin.ts` and the design rationale.
 *
 *   import { pyric } from '@pyric/cli/vite';
 *   export default defineConfig({ plugins: [pyric()] });
 */
export { pyric } from './serve/vite-plugin.js';
export type { PyricOptions } from './serve/vite-plugin.js';

// The benign node-builtin shims serve's bundler and this plugin apply when
// bundling pyric's browser graph (`fs`/`path`/`url` reached via the rules
// module resolver — see `serve/bundler.ts`). Exported so a browser app that
// bundles @pyric/cli' browser-side bridge client (Pyric Studio registers as
// the bridge peer) applies the SAME shims instead of re-deriving them.
export { NODE_BUILTIN_RE, NODE_BUILTIN_SHIMS } from './serve/bundler.js';
