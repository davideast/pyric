/**
 * `@pyric/cli/bundler` — externalization presets and helpers for Node backend
 * bundlers (Rolldown, esbuild, tsup, Rollup, Vite) to preserve `@pyric/cli/register`
 * runtime sandbox interception.
 *
 *   // rolldown.config.ts / rollup.config.js
 *   import { pyricExternals } from '@pyric/cli/bundler';
 *   export default { external: pyricExternals.rolldown };
 *
 *   // vite.config.ts: SSR output only; client builds are unaffected
 *   import { pyricViteExternals } from '@pyric/cli/bundler';
 *   export default { plugins: [pyricViteExternals()] };
 *
 *   // tsup.config.ts / esbuild.config.mjs
 *   export default { external: pyricExternals.esbuild };
 */
export {
  pyricRollupExternals,
  pyricEsbuildExternals,
  pyricExternalPackages,
  isPyricExternal,
  pyricViteExternals,
  pyricExternals,
} from './externals.js';
