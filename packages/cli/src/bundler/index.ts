/**
 * `@pyric/cli/bundler` — externalization presets and helpers for Node backend
 * bundlers (Rolldown, esbuild, tsup, Rollup, Vite) to preserve `@pyric/cli/register`
 * runtime sandbox interception.
 *
 *   // rolldown.config.ts / rollup.config.js
 *   import { pyricExternals } from '@pyric/cli/bundler';
 *   export default { external: pyricExternals.rolldown };
 *
 *   // vite.config.ts (SSR / Node backend builds)
 *   export default { build: { rollupOptions: { external: pyricExternals.vite } } };
 *
 *   // tsup.config.ts / esbuild.config.mjs
 *   export default { external: pyricExternals.esbuild };
 */
export {
  pyricRollupExternals,
  pyricEsbuildExternals,
  isPyricExternal,
  pyricExternals,
} from './externals.js';
