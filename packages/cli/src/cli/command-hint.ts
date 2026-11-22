import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PyricCommandPrefixOptions {
  readonly embedded?: boolean;
  readonly moduleFilePath?: string;
  readonly pathEnv?: string;
  readonly platform?: NodeJS.Platform;
}

function hasEmbeddedRuntime(): boolean {
  const holder = globalThis as { __PYRIC_EMBEDDED__?: unknown };
  return typeof holder.__PYRIC_EMBEDDED__ === 'object' && holder.__PYRIC_EMBEDDED__ !== null;
}

function normalizeSlashes(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function isLocalNodeModulesBin(dirPath: string): boolean {
  const normalized = normalizeSlashes(resolve(dirPath));
  return (
    normalized.endsWith('/node_modules/.bin') ||
    normalized.includes('/node_modules/.bin/')
  );
}

function resolveRealPathOrNull(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch (error) {
    void error;
    return null;
  }
}

function findPackageRoot(filePath: string): string | null {
  const realFile = resolveRealPathOrNull(filePath) ?? resolve(filePath);
  let current = dirname(realFile);
  for (;;) {
    if (existsSync(join(current, 'package.json'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    const st = statSync(candidate);
    if (!st.isFile()) {
      return false;
    }
    if (platform !== 'win32') {
      accessSync(candidate, constants.X_OK);
    }
    return true;
  } catch (error) {
    void error;
    return false;
  }
}

function findGlobalPyricBinary(pathEnv: string, platform: NodeJS.Platform): string | null {
  const names = platform === 'win32' ? ['pyric.cmd', 'pyric.exe', 'pyric'] : ['pyric'];
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  for (const rawEntry of pathEnv.split(pathDelimiter)) {
    const entry = rawEntry.trim();
    if (entry === '' || isLocalNodeModulesBin(entry)) {
      continue;
    }
    for (const name of names) {
      const candidate = join(entry, name);
      if (isExecutableFile(candidate, platform)) {
        return candidate;
      }
    }
  }
  return null;
}

function isInsideNodeModules(filePath: string): boolean {
  return normalizeSlashes(resolve(filePath)).includes('/node_modules/');
}

/**
 * Return `'pyric'` when invoked as the standalone binary or a global PATH
 * install, and `'npx pyric'` when invoked from a local `node_modules` install
 * or without `pyric` on PATH so pasted hints work from the project directory.
 */
export function resolvePyricCommandPrefix(options: PyricCommandPrefixOptions = {}): string {
  const embedded = options.embedded ?? hasEmbeddedRuntime();
  if (embedded) {
    return 'pyric';
  }
  const moduleFilePath = options.moduleFilePath ?? fileURLToPath(import.meta.url);
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const platform = options.platform ?? process.platform;
  const globalBinary = findGlobalPyricBinary(pathEnv, platform);
  if (globalBinary === null) {
    return 'npx pyric';
  }
  if (!isInsideNodeModules(moduleFilePath)) {
    return 'pyric';
  }
  const ownPkgRoot = findPackageRoot(moduleFilePath);
  const binReal = resolveRealPathOrNull(globalBinary);
  if (ownPkgRoot !== null && binReal !== null) {
    const binPkgRoot = findPackageRoot(binReal);
    if (binPkgRoot === ownPkgRoot) {
      return 'pyric';
    }
  }
  return 'npx pyric';
}

/** Format a pasteable `pyric <args>` or `npx pyric <args>` CLI hint. */
export function formatPyricCommand(args: string, options?: PyricCommandPrefixOptions): string {
  const prefix = resolvePyricCommandPrefix(options);
  const trimmed = args.trim();
  if (trimmed === '') {
    return prefix;
  }
  return `${prefix} ${trimmed}`;
}
