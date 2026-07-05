/**
 * Node-side `2+modules` resolver — the disk-reading public API. All the
 * resolution logic lives in `./resolver-core.js` (pure, no node imports);
 * this wrapper supplies the {@link ModuleFileReader} that reads relative
 * imports from `basePath` and stdlib modules from the package's on-disk
 * `stdlib/` directory.
 *
 * NODE-ONLY by construction (static `fs`/`path`/`url` imports). Browser
 * consumers use `./resolver-browser.js`, which binds the core to the
 * inlined stdlib and never touches this file — that separation is the
 * point: these node imports used to leak into browser bundles through
 * `resolver-browser`'s import chain (caught by the pyric-serve P0 validation).
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  loadModuleWith,
  resolveModulesWith,
  type ModuleFileReader,
  type ResolveOptions,
  type ResolveResult,
} from './resolver-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDLIB_DIR = join(__dirname, 'stdlib');

const diskReader: ModuleFileReader = {
  readRelative(basePath, moduleName) {
    try {
      return readFileSync(join(basePath, `${moduleName}.rules`), 'utf-8');
    } catch {
      return null;
    }
  },
  readStdlib(moduleName) {
    try {
      return readFileSync(join(STDLIB_DIR, `${moduleName}.rules`), 'utf-8');
    } catch {
      return null;
    }
  },
};

/** Resolve a `2+modules` source, reading relative + stdlib modules from disk. */
export function resolveModules(source: string, options?: ResolveOptions): ResolveResult {
  return resolveModulesWith(diskReader, source, options);
}

/** Load one module with the disk reader (exposed for `rules/node` consumers). */
export function loadModule(moduleName: string, options?: ResolveOptions) {
  return loadModuleWith(diskReader, moduleName, options);
}

// Pure helpers + types re-exported so existing `./resolver.js` importers
// (`rules/node.js`, `rules/tools.js`) keep their import sites unchanged.
export {
  sanitizeModuleName,
  prefixPrivateFunctions,
  rewriteCalls,
} from './resolver-core.js';
export type { ResolveOptions, ResolveResult, ModuleFileReader } from './resolver-core.js';
