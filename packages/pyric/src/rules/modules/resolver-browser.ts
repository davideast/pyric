/**
 * Browser-safe `resolveModules` wrapper.
 *
 * The on-disk resolver in `./resolver.ts` falls back to `readFileSync`
 * when a `2+modules` import names a stdlib module (priority 4). That
 * path can't run in the browser. This wrapper pre-supplies every
 * stdlib module via the resolver's existing `modules: Record<string,
 * string>` option, so the disk-reading priority-4 path never fires —
 * the inline content satisfies the import first.
 *
 * Stdlib modules are addressable by their KEY (`'auth'`, `'membership'`,
 * etc.). Each module is ALSO registered under its conventional path
 * form (`'./stdlib/auth.rules'`, `'./stdlib/membership.rules'`, etc.)
 * so sources that follow the path-style convention from older docs
 * resolve identically.
 *
 * The Node-only `resolveModules` export still works as before for
 * server consumers (it picks up edits to the `.rules` files between
 * builds without re-running the inliner). Browser consumers should
 * call this wrapper instead.
 *
 * Both `basePath` (for relative-path imports during local
 * development on Node) and user-supplied `modules` (to override the
 * stdlib content) are forwarded — user-supplied entries win over
 * `STDLIB_INLINE` so callers can shadow a stdlib module with their
 * own copy when needed.
 *
 * BROWSER-CLEAN by construction: binds the pure core (`resolver-core.js`)
 * with NO disk reader — this module must never import `./resolver.js`
 * (the node wrapper), whose static `fs`/`path`/`url` imports used to leak
 * into browser bundles through exactly that edge (caught by the
 * pyric-serve P0 validation). Relative-path imports (`./foo`) therefore
 * resolve only via an explicit `options.modules` entry here; the
 * disk-backed `basePath` behavior remains on the node `resolveModules`.
 */

import { resolveModulesWith, type ResolveOptions, type ResolveResult } from './resolver-core.js';
import { STDLIB_INLINE } from './stdlib-content.js';

/**
 * Build a `modules` map that accepts both `'<key>'` and
 * `'./stdlib/<key>.rules'` forms of every stdlib module. Cheap —
 * doubles the entry count but the inline content is shared by
 * reference, not duplicated.
 */
function buildStdlibModuleMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, content] of Object.entries(STDLIB_INLINE)) {
    out[key] = content;
    out[`./stdlib/${key}.rules`] = content;
  }
  return out;
}

const STDLIB_WITH_PATH_ALIASES = buildStdlibModuleMap();
const BUNDLED_STDLIB_NAMES = new Set(Object.keys(STDLIB_WITH_PATH_ALIASES));

export function resolveModulesBrowser(
  source: string,
  options?: ResolveOptions,
): ResolveResult {
  const callerModules = options?.modules ?? {};
  const bundledModules = new Set(
    [...BUNDLED_STDLIB_NAMES].filter((name) => !(name in callerModules)),
  );
  return resolveModulesWith(null, source, {
    ...options,
    modules: {
      ...STDLIB_WITH_PATH_ALIASES,
      ...callerModules,
    },
  }, bundledModules);
}

export { STDLIB_INLINE };
export type { ResolveResult, ResolveOptions };
