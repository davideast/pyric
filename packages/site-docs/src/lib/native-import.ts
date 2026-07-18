/**
 * Import a package through the runtime's native resolution, bypassing Vite.
 * Content-layer loaders run after Astro tears down the config-load module
 * runner, so a plain dynamic import() inside load() dies with "Vite module
 * runner has been closed". These are Node-side packages (built dist,
 * TypeDoc) — Vite has no business transforming them anyway.
 *
 * The import is constructed at runtime so Vite's SSR transform cannot
 * rewrite it into a module-runner import. The bare specifier goes straight
 * to the runtime resolver (Bun's createRequire().resolve does not traverse
 * `exports` subpaths, so no resolve-then-import indirection).
 */
const importUntransformed = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

export async function nativeImport<T = Record<string, unknown>>(specifier: string): Promise<T> {
  return (await importUntransformed(specifier)) as T;
}
