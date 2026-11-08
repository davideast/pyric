/**
 * Lazy disk walking and filesystem adapter for Node/Bun callers that pass a
 * directory `root` without pre-loaded `files`.
 *
 * Acquires `node:fs` and `node:path` via `process.getBuiltinModule` so no
 * static or dynamic `node:*` import exists for browser bundlers to chase.
 */
import { posixJoin, toPosixPath } from './posix-path.js';

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const TSCONFIG_NAME = /^tsconfig(?:\.[\w-]+)?\.json$/;
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'out',
  '.next',
  '.pyric',
  '.turbo',
  '.cache',
]);

interface RawStat {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
}

interface RawNodeFs {
  readdirSync(dir: string): string[];
  statSync(path: string): RawStat;
  readFileSync(path: string, encoding: 'utf-8'): string;
  realpathSync?: (path: string) => string;
}

interface RawNodePath {
  resolve(...paths: string[]): string;
}

interface DiskWalkResult {
  readonly sources: string[];
  readonly configs: string[];
}

export interface DiskAdapter {
  resolve(...paths: string[]): string;
  fileExists(path: string): boolean;
  directoryExists(path: string): boolean;
  readFile(path: string): string | undefined;
  getDirectories(path: string): string[];
  realpath(path: string): string;
  walk(root: string, maxSourceBytes: number): DiskWalkResult;
}

function loadNodeBuiltins(): { fs: RawNodeFs; path: RawNodePath } | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const get = proc?.getBuiltinModule;
  if (typeof get !== 'function') return null;
  const fs = get.call(proc, 'node:fs') as RawNodeFs | undefined;
  const path = get.call(proc, 'node:path') as RawNodePath | undefined;
  if (!fs || !path) return null;
  return { fs, path };
}

export function acquireDiskAdapter(): DiskAdapter {
  const builtins = loadNodeBuiltins();
  if (!builtins) {
    throw new Error(
      'Filesystem scanning requires Node >= 20.16 (`process.getBuiltinModule`); pass in-memory `files` in browser environments.',
    );
  }
  const { fs, path } = builtins;

  const resolve = (...segments: string[]): string => toPosixPath(path.resolve(...segments));

  const statOrNull = (target: string): RawStat | null => {
    try {
      return fs.statSync(target);
    } catch {
      return null;
    }
  };

  return {
    resolve,
    fileExists(target: string): boolean {
      const st = statOrNull(target);
      return st !== null && st.isFile();
    },
    directoryExists(target: string): boolean {
      const st = statOrNull(target);
      return st !== null && st.isDirectory();
    },
    readFile(target: string): string | undefined {
      try {
        return fs.readFileSync(target, 'utf-8');
      } catch {
        return undefined;
      }
    },
    getDirectories(target: string): string[] {
      let entries: string[];
      try {
        entries = fs.readdirSync(target);
      } catch {
        return [];
      }
      const dirs: string[] = [];
      for (const name of entries) {
        const st = statOrNull(posixJoin(target, name));
        if (st && st.isDirectory()) dirs.push(name);
      }
      return dirs;
    },
    realpath(target: string): string {
      if (typeof fs.realpathSync !== 'function') return toPosixPath(target);
      try {
        return toPosixPath(fs.realpathSync(target));
      } catch {
        return toPosixPath(target);
      }
    },
    walk(root: string, maxSourceBytes: number): DiskWalkResult {
      const sources: string[] = [];
      const configs: string[] = [];
      const visit = (dir: string): void => {
        let entries: string[];
        try {
          entries = fs.readdirSync(dir);
        } catch {
          return;
        }
        for (const name of entries) {
          const full = posixJoin(dir, name);
          const st = statOrNull(full);
          if (!st) continue;
          if (st.isDirectory()) {
            if (!SKIPPED_DIRS.has(name)) visit(full);
          } else if (TSCONFIG_NAME.test(name)) {
            configs.push(full);
          } else if (SOURCE_EXTENSION.test(name) && st.size <= maxSourceBytes) {
            sources.push(full);
          }
        }
      };
      visit(resolve(root));
      sources.sort();
      configs.sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
      return { sources, configs };
    },
  };
}
