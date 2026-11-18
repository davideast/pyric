import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isAllowlistedPyricCacheRoot, isUnsafeCacheRoot } from './bundle-cache-evict.js';

const DEFAULT_STANDALONE_SERVE_MAX_ENTRIES = 4;
const DEFAULT_STANDALONE_MIN_EVICT_AGE_MS = 2 * 60 * 60 * 1000;
export const STANDALONE_SERVE_MARKER = '.pyric-standalone';

interface StandaloneServeEvictOptions {
  maxEntries?: number;
  minAgeMs?: number;
  nowMs?: number;
  allowCustomRootForTesting?: boolean;
}

function readPositiveEnvInt(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) === false || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function resolveExistingRealPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isEqualOrInsideDir(parentDir: string, candidateReal: string): boolean {
  let parentBase = resolve(parentDir);
  const parentReal = resolveExistingRealPath(parentBase);
  if (parentReal !== null) {
    parentBase = parentReal;
  }
  const rel = relative(parentBase, candidateReal);
  return rel === '' || (rel.startsWith('..') === false && isAbsolute(rel) === false);
}

function isRealDirectory(path: string): boolean {
  try {
    const st = lstatSync(path, { throwIfNoEntry: false });
    return st !== undefined && st.isSymbolicLink() === false && st.isDirectory();
  } catch {
    return false;
  }
}

function isRegularMarkerFile(path: string): boolean {
  try {
    const st = lstatSync(path, { throwIfNoEntry: false });
    return st !== undefined && st.isSymbolicLink() === false && st.isFile();
  } catch {
    return false;
  }
}

function entryMtimeMs(path: string): number | null {
  try {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st === undefined || st.isSymbolicLink() || st.isDirectory() === false) {
      return null;
    }
    return st.mtimeMs;
  } catch {
    return null;
  }
}

function safeRemoveDir(path: string): boolean {
  if (isUnsafeCacheRoot(path) || isRealDirectory(path) === false) {
    return false;
  }
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * True only when `realpathSync(cacheRoot)` resolves to `~/.pyric/standalone-serve`
 * (or a subdirectory inside it) or `~/.cache/pyric-*` (excluding `tmpdir()` and
 * `~/.cache/pyric-tmp*`).
 */
export function isAllowlistedStandaloneServeRoot(cacheRoot: string): boolean {
  if (isUnsafeCacheRoot(cacheRoot)) {
    return false;
  }
  const realRoot = resolveExistingRealPath(cacheRoot);
  if (realRoot === null || isEqualOrInsideDir(tmpdir(), realRoot)) {
    return false;
  }
  const standaloneRoot = join(homedir(), '.pyric', 'standalone-serve');
  if (isEqualOrInsideDir(standaloneRoot, realRoot)) {
    return true;
  }
  const pyricParent = join(homedir(), '.pyric');
  if (isEqualOrInsideDir(pyricParent, realRoot)) {
    return false;
  }
  return isAllowlistedPyricCacheRoot(cacheRoot);
}

function isStandaloneServeDirectory(dir: string): boolean {
  if (isRegularMarkerFile(join(dir, STANDALONE_SERVE_MARKER)) === false) {
    return false;
  }
  return (
    isRegularMarkerFile(join(dir, 'sdk', '.complete')) ||
    isRegularMarkerFile(join(dir, 'site-ui', '.complete'))
  );
}

export function evictStandaloneServeCache(
  cacheRoot: string,
  keepName: string,
  options: StandaloneServeEvictOptions = {},
): string[] {
  const removed: string[] = [];
  if (
    existsSync(cacheRoot) === false ||
    isUnsafeCacheRoot(cacheRoot) ||
    isRealDirectory(cacheRoot) === false
  ) {
    return removed;
  }
  if (
    options.allowCustomRootForTesting !== true &&
    isAllowlistedStandaloneServeRoot(cacheRoot) === false
  ) {
    return removed;
  }
  let maxEntries = readPositiveEnvInt(
    'PYRIC_STANDALONE_SERVE_MAX_ENTRIES',
    DEFAULT_STANDALONE_SERVE_MAX_ENTRIES,
  );
  if (options.maxEntries !== undefined) {
    maxEntries = options.maxEntries;
  }
  let minAgeMs = DEFAULT_STANDALONE_MIN_EVICT_AGE_MS;
  if (options.minAgeMs !== undefined) {
    minAgeMs = options.minAgeMs;
  }
  let nowMs = Date.now();
  if (options.nowMs !== undefined) {
    nowMs = options.nowMs;
  }

  let names: string[] = [];
  try {
    names = readdirSync(cacheRoot);
  } catch {
    return removed;
  }

  const entries: Array<{ name: string; full: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (name === keepName || name.startsWith('.')) {
      continue;
    }
    const full = join(cacheRoot, name);
    const mtimeMs = entryMtimeMs(full);
    if (mtimeMs === null || isStandaloneServeDirectory(full) === false) {
      continue;
    }
    entries.push({ name, full, mtimeMs });
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keepBudget = Math.max(0, maxEntries - 1);
  for (const entry of entries.slice(keepBudget)) {
    if (nowMs - entry.mtimeMs >= minAgeMs && safeRemoveDir(entry.full)) {
      removed.push(entry.name);
    }
  }
  return removed;
}
