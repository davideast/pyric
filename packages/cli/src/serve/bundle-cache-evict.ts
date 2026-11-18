import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LOCK_DIR } from './worker-build-lock.js';

const DEFAULT_VITE_WORKER_MAX_ENTRIES = 8;
const DEFAULT_SERVE_CACHE_MAX_ENTRIES = 16;
const DEFAULT_SALTED_WORKER_MAX_ENTRIES = 8;
const DEFAULT_MIN_EVICT_AGE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SALTED_MIN_EVICT_AGE_MS = 30 * 60 * 1000;
export const NO_CACHE_MARKER = '.pyric-nocache';
export const SALTED_WORKER_MARKER = '.salted-worker';
const WORKER_COMPLETE_MARKER = '.worker-complete';
const WORKER_EPOCH_MARKER = '.worker-epoch';
const POSIX_SHARED_TEMP_DIRS = [
  '/tmp',
  '/var/tmp',
  '/private/tmp',
  '/private/var/tmp',
  '/run',
  '/dev/shm',
];

interface ServeCacheEvictOptions {
  maxEntries?: number;
  minAgeMs?: number;
  nowMs?: number;
  allowCustomRootForTesting?: boolean;
}

interface ViteWorkerEvictOptions {
  maxEntries?: number;
  saltedMaxEntries?: number;
  minAgeMs?: number;
  saltedMinAgeMs?: number;
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

function isFilesystemRoot(path: string): boolean {
  return dirname(path) === path;
}

function addProtectedPath(paths: Set<string>, path: string): void {
  const resolved = resolve(path);
  paths.add(resolved);
  const real = resolveExistingRealPath(resolved);
  if (real !== null) {
    paths.add(real);
  }
}

function protectedSharedRoots(): Set<string> {
  const roots = new Set<string>();
  const home = homedir();
  addProtectedPath(roots, tmpdir());
  addProtectedPath(roots, home);
  addProtectedPath(roots, dirname(resolve(home)));
  addProtectedPath(roots, join(home, '.pyric'));
  addProtectedPath(roots, join(home, '.cache'));
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntimeDir !== undefined && xdgRuntimeDir.trim() !== '') {
    addProtectedPath(roots, xdgRuntimeDir);
  }
  if (process.platform !== 'win32') {
    for (const dir of POSIX_SHARED_TEMP_DIRS) {
      addProtectedPath(roots, dir);
    }
    if (typeof process.getuid === 'function') {
      addProtectedPath(roots, `/run/user/${String(process.getuid())}`);
    }
  }
  return roots;
}

export function isUnsafeCacheRoot(cacheRoot: string): boolean {
  if (cacheRoot.trim() === '') {
    return true;
  }
  const resolved = resolve(cacheRoot);
  if (isFilesystemRoot(resolved)) {
    return true;
  }
  const real = resolveExistingRealPath(resolved);
  if (real !== null && isFilesystemRoot(real)) {
    return true;
  }
  const protectedRoots = protectedSharedRoots();
  if (protectedRoots.has(resolved)) {
    return true;
  }
  return real !== null && protectedRoots.has(real);
}

function isStrictlyInsideDir(parentDir: string, candidateReal: string): boolean {
  let parentBase = resolve(parentDir);
  const parentReal = resolveExistingRealPath(parentBase);
  if (parentReal !== null) {
    parentBase = parentReal;
  }
  const rel = relative(parentBase, candidateReal);
  return rel !== '' && rel.startsWith('..') === false && isAbsolute(rel) === false;
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

/**
 * True only when `realpathSync(cacheRoot)` resolves strictly inside
 * `~/.pyric/<subroot>` or `~/.cache/pyric-*` (excluding `tmpdir()` and
 * `~/.cache/pyric-tmp*` per-job temp trees).
 */
export function isAllowlistedPyricCacheRoot(cacheRoot: string): boolean {
  const realRoot = resolveExistingRealPath(cacheRoot);
  if (realRoot === null) {
    return false;
  }
  if (isEqualOrInsideDir(tmpdir(), realRoot)) {
    return false;
  }
  const home = homedir();
  if (isStrictlyInsideDir(join(home, '.pyric'), realRoot)) {
    return true;
  }
  let cacheBase = resolve(join(home, '.cache'));
  const cacheBaseReal = resolveExistingRealPath(cacheBase);
  if (cacheBaseReal !== null) {
    cacheBase = cacheBaseReal;
  }
  const relCache = relative(cacheBase, realRoot);
  if (relCache === '' || relCache.startsWith('..') || isAbsolute(relCache)) {
    return false;
  }
  const firstSegment = relCache.split(sep)[0];
  if (
    firstSegment === undefined ||
    firstSegment.startsWith('pyric-') === false ||
    firstSegment.length <= 'pyric-'.length
  ) {
    return false;
  }
  return firstSegment !== 'pyric-tmp' && firstSegment.startsWith('pyric-tmp-') === false;
}

function canEvictFromCacheRoot(cacheRoot: string, allowCustomRootForTesting?: boolean): boolean {
  if (existsSync(cacheRoot) === false || isUnsafeCacheRoot(cacheRoot)) {
    return false;
  }
  if (allowCustomRootForTesting === true) {
    return true;
  }
  return isAllowlistedPyricCacheRoot(cacheRoot);
}

/** True when `dir` is the default `~/.pyric/vite-worker` managed cache root. */
export function isDefaultViteWorkerCacheRoot(dir: string): boolean {
  const defaultRoot = resolve(join(homedir(), '.pyric', 'vite-worker'));
  const candidate = resolve(dir);
  if (candidate === defaultRoot) {
    return true;
  }
  const defaultReal = resolveExistingRealPath(defaultRoot);
  const candidateReal = resolveExistingRealPath(candidate);
  return defaultReal !== null && candidateReal !== null && candidateReal === defaultReal;
}

function isServeCacheDirectory(dir: string): boolean {
  return existsSync(join(dir, 'sdk', '.complete'));
}

function isNoCacheGenerationDirectory(dir: string): boolean {
  return existsSync(join(dir, NO_CACHE_MARKER)) || isServeCacheDirectory(dir);
}

function isWorkerCacheDirectory(dir: string): boolean {
  return (
    existsSync(join(dir, WORKER_COMPLETE_MARKER)) ||
    existsSync(join(dir, WORKER_EPOCH_MARKER)) ||
    existsSync(join(dir, SALTED_WORKER_MARKER))
  );
}

function isRealDirectory(path: string): boolean {
  try {
    const st = lstatSync(path, { throwIfNoEntry: false });
    return st !== undefined && st.isSymbolicLink() === false && st.isDirectory();
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

function extractProjectKeyFromSalt(epochSalt: string | undefined): string | null {
  if (epochSalt === undefined || epochSalt.startsWith('{') === false) {
    return null;
  }
  try {
    const parsed = JSON.parse(epochSalt) as { projectKey?: unknown };
    if (typeof parsed.projectKey === 'string' && parsed.projectKey.startsWith('/')) {
      return parsed.projectKey;
    }
    return null;
  } catch {
    return null;
  }
}

function saltedProjectKeyIsMissing(dir: string): boolean {
  try {
    const raw = readFileSync(join(dir, SALTED_WORKER_MARKER), 'utf8').trim();
    if (raw.startsWith('{') === false) {
      return false;
    }
    const parsed = JSON.parse(raw) as { projectKey?: unknown };
    if (typeof parsed.projectKey !== 'string' || parsed.projectKey.startsWith('/') === false) {
      return false;
    }
    return existsSync(parsed.projectKey) === false;
  } catch {
    return false;
  }
}

export function createNoCacheGenerationDir(cacheRoot: string, key: string): string {
  mkdirSync(cacheRoot, { recursive: true });
  const dir = mkdtempSync(join(cacheRoot, `.no-cache-${key}-`));
  writeFileSync(join(dir, NO_CACHE_MARKER), '1');
  return dir;
}

export function disposeNoCacheGenerationDir(generationRoot: string): void {
  if (basename(generationRoot).startsWith('.no-cache-') === false) {
    return;
  }
  if (isUnsafeCacheRoot(dirname(generationRoot))) {
    return;
  }
  if (isRealDirectory(generationRoot) === false) {
    return;
  }
  if (isNoCacheGenerationDirectory(generationRoot) === false) {
    return;
  }
  safeRemoveDir(generationRoot);
}

export function disposeSaltedWorkerDir(
  activeDir: string,
  allowCustomRootForTesting?: boolean,
): void {
  if (canEvictFromCacheRoot(dirname(activeDir), allowCustomRootForTesting) === false) {
    return;
  }
  if (isRealDirectory(activeDir) === false) {
    return;
  }
  if (existsSync(join(activeDir, LOCK_DIR))) {
    return;
  }
  if (existsSync(join(activeDir, SALTED_WORKER_MARKER)) === false) {
    return;
  }
  safeRemoveDir(activeDir);
}

export function touchBundleCacheDir(dir: string, nowMs = Date.now()): void {
  try {
    const secs = nowMs / 1000;
    utimesSync(dir, secs, secs);
  } catch {
    // Best-effort recency stamp; read-only or concurrently removed dirs are harmless.
  }
}

export function markSaltedWorkerDir(dir: string, epochSalt?: string): void {
  try {
    const projectKey = extractProjectKeyFromSalt(epochSalt);
    let payload = '1';
    if (projectKey !== null) {
      payload = JSON.stringify({ projectKey });
    }
    writeFileSync(join(dir, SALTED_WORKER_MARKER), payload);
  } catch {
    // Best-effort marker for salted worker generations.
  }
}

export function evictServeCache(
  cacheRoot: string,
  keepName: string,
  staleNoCacheMs: number,
  options: ServeCacheEvictOptions = {},
): string[] {
  const removed: string[] = [];
  if (canEvictFromCacheRoot(cacheRoot, options.allowCustomRootForTesting) === false) {
    return removed;
  }
  let maxEntries = readPositiveEnvInt('PYRIC_SERVE_CACHE_MAX_ENTRIES', DEFAULT_SERVE_CACHE_MAX_ENTRIES);
  if (options.maxEntries !== undefined) {
    maxEntries = options.maxEntries;
  }
  let minAgeMs = DEFAULT_MIN_EVICT_AGE_MS;
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

  const warmEntries: Array<{ name: string; full: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (name === keepName) {
      continue;
    }
    const full = join(cacheRoot, name);
    const mtimeMs = entryMtimeMs(full);
    if (mtimeMs === null) {
      continue;
    }
    if (name.startsWith('.no-cache-')) {
      if (isNoCacheGenerationDirectory(full) === false) {
        continue;
      }
      let noCacheMaxAgeMs = staleNoCacheMs;
      if (isServeCacheDirectory(full)) {
        noCacheMaxAgeMs = minAgeMs;
      }
      if (nowMs - mtimeMs >= noCacheMaxAgeMs && safeRemoveDir(full)) {
        removed.push(name);
      }
      continue;
    }
    if (name.startsWith('.')) {
      continue;
    }
    if (isServeCacheDirectory(full) === false) {
      continue;
    }
    warmEntries.push({ name, full, mtimeMs });
  }

  warmEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keepBudget = Math.max(0, maxEntries - 1);
  for (const entry of warmEntries.slice(keepBudget)) {
    if (nowMs - entry.mtimeMs >= minAgeMs && safeRemoveDir(entry.full)) {
      removed.push(entry.name);
    }
  }
  return removed;
}

export function evictViteWorkerCache(
  cacheRoot: string,
  keepName: string,
  options: ViteWorkerEvictOptions = {},
): string[] {
  const removed: string[] = [];
  if (canEvictFromCacheRoot(cacheRoot, options.allowCustomRootForTesting) === false) {
    return removed;
  }
  let maxEntries = readPositiveEnvInt('PYRIC_VITE_WORKER_MAX_ENTRIES', DEFAULT_VITE_WORKER_MAX_ENTRIES);
  if (options.maxEntries !== undefined) {
    maxEntries = options.maxEntries;
  }
  let saltedMaxEntries = DEFAULT_SALTED_WORKER_MAX_ENTRIES;
  if (options.saltedMaxEntries !== undefined) {
    saltedMaxEntries = options.saltedMaxEntries;
  }
  let minAgeMs = DEFAULT_MIN_EVICT_AGE_MS;
  if (options.minAgeMs !== undefined) {
    minAgeMs = options.minAgeMs;
  }
  let saltedMinAgeMs = DEFAULT_SALTED_MIN_EVICT_AGE_MS;
  if (options.saltedMinAgeMs !== undefined) {
    saltedMinAgeMs = options.saltedMinAgeMs;
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

  const unsalted: Array<{ name: string; full: string; mtimeMs: number }> = [];
  const salted: Array<{ name: string; full: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (name === keepName || name.startsWith('.')) {
      continue;
    }
    const full = join(cacheRoot, name);
    const mtimeMs = entryMtimeMs(full);
    if (mtimeMs === null) {
      continue;
    }
    if (existsSync(join(full, LOCK_DIR))) {
      continue;
    }
    if (existsSync(join(full, SALTED_WORKER_MARKER))) {
      if (saltedProjectKeyIsMissing(full)) {
        if (safeRemoveDir(full)) {
          removed.push(name);
        }
        continue;
      }
      salted.push({ name, full, mtimeMs });
    } else if (isWorkerCacheDirectory(full)) {
      unsalted.push({ name, full, mtimeMs });
    }
  }

  salted.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of salted.slice(saltedMaxEntries)) {
    if (nowMs - entry.mtimeMs >= saltedMinAgeMs && safeRemoveDir(entry.full)) {
      removed.push(entry.name);
    }
  }

  unsalted.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keepBudget = Math.max(0, maxEntries - 1);
  for (const entry of unsalted.slice(keepBudget)) {
    if (nowMs - entry.mtimeMs >= minAgeMs && safeRemoveDir(entry.full)) {
      removed.push(entry.name);
    }
  }
  return removed;
}
