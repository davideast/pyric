/**
 * Externalization presets and helpers for Node backend bundlers.
 *
 * Prevents backend bundlers (Rolldown, esbuild, tsup, Rollup, Vite, Webpack)
 * from inlining Firebase and Firebase Admin SDKs into bundled server outputs,
 * preserving runtime interception by `@pyric/cli/register` under `pyric sandbox`.
 */

/**
 * RegExp patterns matching Firebase packages for bundlers that accept RegExp
 * in their external configuration (Rolldown, Rollup, Vite, Webpack).
 */
export const pyricRollupExternals: readonly RegExp[] = Object.freeze([
  /^firebase-admin(\/.*)?$/,
  /^firebase(\/.*)?$/,
  /^@firebase(\/.*)?$/,
]);

/**
 * Wildcard string patterns matching Firebase packages for bundlers that require
 * string arrays with glob wildcards (esbuild, tsup).
 */
export const pyricEsbuildExternals: readonly string[] = Object.freeze([
  'firebase-admin',
  'firebase-admin/*',
  'firebase',
  'firebase/*',
  '@firebase/*',
]);

/**
 * Universal predicate returning true if a module specifier belongs to Firebase
 * or Firebase Admin SDK surfaces intercepted by Pyric.
 *
 * Compatible with bundlers that accept a function in their external setting
 * (Rolldown, Rollup, Vite, Webpack).
 */
export function isPyricExternal(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) {
    return false;
  }
  return pyricRollupExternals.some((regex) => regex.test(id));
}

/**
 * Convenience presets mapping bundler names to their supported external pattern format.
 */
export const pyricExternals = Object.freeze({
  rolldown: pyricRollupExternals,
  rollup: pyricRollupExternals,
  vite: pyricRollupExternals,
  webpack: pyricRollupExternals,
  esbuild: pyricEsbuildExternals,
  tsup: pyricEsbuildExternals,
});
