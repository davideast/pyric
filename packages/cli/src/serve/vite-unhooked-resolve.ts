import { existsSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Node's CommonJS resolver, typed locally: the repo's ambient Node types
 * leave out these internals.
 */
interface CommonJsResolver {
  _resolveFilename?: (request: string, parent: unknown, isMain: boolean) => string;
  _nodeModulePaths?: (from: string) => string[];
}

type ModuleConstructor = new (id: string) => { filename: string; paths: string[] };

const moduleApi = Module as unknown as CommonJsResolver & ModuleConstructor;

export function packageRootOf(file: string): string {
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir) && !existsSync(path.join(dir, 'package.json'))) {
    dir = path.dirname(dir);
  }
  return dir;
}

/**
 * The file Node resolves `specifier` to from `base`, without running the
 * process's `module.registerHooks` resolve hooks. From Node 24.16 those hooks
 * also run for `require.resolve`: pyric's own stop hook throws there, which
 * read as "not installed", and the register maps `firebase-admin` to
 * `pyric-admin`, which read as "not the real SDK", so the stop was skipped
 * (#1906). `Module._resolveFilename` runs below the hooks on Node 22.15 and
 * 24.16. Falls back to `createRequire` on a runtime without it.
 */
export function resolveUnhooked(specifier: string, base: string): string {
  const resolveFilename = moduleApi._resolveFilename;
  const nodeModulePaths = moduleApi._nodeModulePaths;
  const hasInternals = typeof resolveFilename === 'function' && typeof nodeModulePaths === 'function';
  if (!hasInternals) return createRequire(base).resolve(specifier);
  const parent = new moduleApi(base);
  parent.filename = base;
  parent.paths = nodeModulePaths.call(Module, path.dirname(base));
  return resolveFilename.call(Module, specifier, parent, false);
}
