import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HELD_SLOT_ENV, isStale, slotDirectory, type SlotHolder } from '../../scripts/lib/heavy-run-slots.ts';

const DEFAULT_DEPS_MAX_ENTRIES = 12;
const DEFAULT_DEPS_MIN_IDLE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_STALE_WARM_MS = 2 * 60 * 60 * 1000;
const DEFAULT_NPM_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NPM_CACHE_MAX_GB = 8;
const BYTES_PER_GIB = 1024 * 1024 * 1024;
const STORE_RECORD_FILE = 'store.json';
export const WARM_ENTRY_MARKER = '.pyric-warm';
const SLOT_LOCK_PATTERN = /^slot-\d+\.lock$/;
const POSIX_SHARED_TEMP_DIRS = [
  '/tmp',
  '/var/tmp',
  '/private/tmp',
  '/private/var/tmp',
  '/run',
  '/dev/shm',
];

interface DependencyStorePruneOptions {
  maxEntries?: number;
  minIdleMs?: number;
  staleWarmMs?: number;
  nowMs?: number;
  allowCustomRootForTesting?: boolean;
}

interface NpmCachePruneOptions {
  maxLogAgeMs?: number;
  maxCacheBytes?: number;
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  cleanCache?: (npmCacheDir: string) => void;
  nowMs?: number;
  allowCustomRootForTesting?: boolean;
}

function readPositiveEnvInt(envName: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[envName];
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

function isUnsafeScenarioCacheRoot(cacheRoot: string): boolean {
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

function isEqualOrInsideDir(parentDir: string, candidateReal: string): boolean {
  let parentBase = resolve(parentDir);
  const parentReal = resolveExistingRealPath(parentBase);
  if (parentReal !== null) {
    parentBase = parentReal;
  }
  const rel = relative(parentBase, candidateReal);
  return rel === '' || (rel.startsWith('..') === false && isAbsolute(rel) === false);
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

export function isAllowlistedScenarioCacheRoot(cacheRoot: string): boolean {
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

function canPruneScenarioRoot(cacheRoot: string, allowCustomRootForTesting?: boolean): boolean {
  if (existsSync(cacheRoot) === false || isUnsafeScenarioCacheRoot(cacheRoot)) {
    return false;
  }
  if (allowCustomRootForTesting === true) {
    return true;
  }
  return isAllowlistedScenarioCacheRoot(cacheRoot);
}

function isRealDirectory(path: string): boolean {
  try {
    const st = lstatSync(path, { throwIfNoEntry: false });
    return st !== undefined && st.isSymbolicLink() === false && st.isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    const st = lstatSync(path, { throwIfNoEntry: false });
    return st !== undefined && st.isSymbolicLink() === false && st.isFile();
  } catch {
    return false;
  }
}

function safeRemoveDir(path: string): boolean {
  if (isUnsafeScenarioCacheRoot(path) || isRealDirectory(path) === false) {
    return false;
  }
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function safeRemoveRegularFile(path: string): boolean {
  if (isRegularFile(path) === false) {
    return false;
  }
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function touchDependencyStoreEntry(entryDir: string, nowMs = Date.now()): void {
  try {
    if (isRealDirectory(entryDir) === false) {
      return;
    }
    const secs = nowMs / 1000;
    const recordPath = join(entryDir, STORE_RECORD_FILE);
    if (isRegularFile(recordPath)) {
      utimesSync(recordPath, secs, secs);
    }
    utimesSync(entryDir, secs, secs);
  } catch {
    // Best-effort recency stamp on store hit.
  }
}

function readEntryFormat(entryDir: string): number | null {
  const recordPath = join(entryDir, STORE_RECORD_FILE);
  if (isRegularFile(recordPath) === false) {
    return null;
  }
  try {
    const raw = readFileSync(recordPath, 'utf8');
    const parsed = JSON.parse(raw) as { format?: unknown };
    if (typeof parsed.format === 'number' && Number.isFinite(parsed.format)) {
      return parsed.format;
    }
    return null;
  } catch {
    return null;
  }
}

function readEntryLastUsedMs(entryDir: string): number | null {
  if (isRealDirectory(entryDir) === false) {
    return null;
  }
  const recordPath = join(entryDir, STORE_RECORD_FILE);
  try {
    const recordStat = lstatSync(recordPath, { throwIfNoEntry: false });
    if (recordStat === undefined || recordStat.isSymbolicLink() || recordStat.isFile() === false) {
      return null;
    }
    return recordStat.mtimeMs;
  } catch {
    return null;
  }
}

function isWarmStagingDirectory(entryDir: string): boolean {
  if (isRealDirectory(entryDir) === false) {
    return false;
  }
  return (
    isRegularFile(join(entryDir, WARM_ENTRY_MARKER)) ||
    isRegularFile(join(entryDir, 'package.json')) ||
    isRegularFile(join(entryDir, STORE_RECORD_FILE))
  );
}

export function pruneDependencyStore(
  storeDir: string,
  currentFormat: number,
  options: DependencyStorePruneOptions = {},
): string[] {
  const removed: string[] = [];
  if (canPruneScenarioRoot(storeDir, options.allowCustomRootForTesting) === false) {
    return removed;
  }
  let maxEntries = readPositiveEnvInt('PYRIC_APPS_DEPS_MAX_ENTRIES', DEFAULT_DEPS_MAX_ENTRIES);
  if (options.maxEntries !== undefined) {
    maxEntries = options.maxEntries;
  }
  let minIdleMs = DEFAULT_DEPS_MIN_IDLE_MS;
  if (options.minIdleMs !== undefined) {
    minIdleMs = options.minIdleMs;
  }
  let staleWarmMs = DEFAULT_STALE_WARM_MS;
  if (options.staleWarmMs !== undefined) {
    staleWarmMs = options.staleWarmMs;
  }
  let nowMs = Date.now();
  if (options.nowMs !== undefined) {
    nowMs = options.nowMs;
  }

  let names: string[] = [];
  try {
    names = readdirSync(storeDir);
  } catch {
    return removed;
  }

  const activeEntries: Array<{ name: string; full: string; mtimeMs: number }> = [];
  for (const name of names) {
    const full = join(storeDir, name);
    if (name.startsWith('.warm-')) {
      if (isWarmStagingDirectory(full) === false) {
        continue;
      }
      const warmStat = lstatSync(full, { throwIfNoEntry: false });
      if (
        warmStat !== undefined &&
        warmStat.isSymbolicLink() === false &&
        warmStat.isDirectory() &&
        nowMs - warmStat.mtimeMs >= staleWarmMs &&
        safeRemoveDir(full)
      ) {
        removed.push(name);
      }
      continue;
    }
    if (name.startsWith('.')) {
      continue;
    }
    const mtimeMs = readEntryLastUsedMs(full);
    const format = readEntryFormat(full);
    if (mtimeMs === null || format === null) {
      continue;
    }
    if (format !== currentFormat) {
      if (nowMs - mtimeMs >= minIdleMs && safeRemoveDir(full)) {
        removed.push(name);
      }
      continue;
    }
    activeEntries.push({ name, full, mtimeMs });
  }

  activeEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of activeEntries.slice(maxEntries)) {
    if (nowMs - entry.mtimeMs >= minIdleMs && safeRemoveDir(entry.full)) {
      removed.push(entry.name);
    }
  }
  return removed;
}

function directoryBytes(root: string): number {
  if (isRealDirectory(root) === false) {
    return 0;
  }
  let total = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) {
      continue;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const st = lstatSync(full, { throwIfNoEntry: false });
          if (st !== undefined && st.isSymbolicLink() === false && st.isFile()) {
            total += st.size;
          }
        } catch {
          // Ignore concurrent removals.
        }
      }
    }
  }
  return total;
}

function hasSiblingHeavyRun(env: NodeJS.ProcessEnv): boolean {
  const slotsDir = slotDirectory(env);
  if (existsSync(slotsDir) === false) {
    return false;
  }
  let ownSlot = '';
  const heldRaw = env[HELD_SLOT_ENV];
  if (heldRaw !== undefined && heldRaw !== '') {
    ownSlot = resolve(heldRaw);
  }
  let names: string[] = [];
  try {
    names = readdirSync(slotsDir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (SLOT_LOCK_PATTERN.test(name) === false) {
      continue;
    }
    const full = resolve(slotsDir, name);
    if (full === ownSlot) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as SlotHolder;
      if (isStale(parsed) === false) {
        return true;
      }
    } catch {
      // Unreadable or vanished slot file; treat as non-blocking.
    }
  }
  return false;
}

function defaultCleanNpmCache(npmCacheDir: string): void {
  execFileSync('npm', ['cache', 'clean', '--force', '--cache', npmCacheDir], { stdio: 'ignore' });
}

export function pruneScenarioNpmCache(
  npmCacheDir: string,
  options: NpmCachePruneOptions = {},
): string[] {
  const removed: string[] = [];
  if (canPruneScenarioRoot(npmCacheDir, options.allowCustomRootForTesting) === false) {
    return removed;
  }
  let env = process.env;
  if (options.env !== undefined) {
    env = options.env;
  }
  let maxLogAgeMs = DEFAULT_NPM_LOG_MAX_AGE_MS;
  if (options.maxLogAgeMs !== undefined) {
    maxLogAgeMs = options.maxLogAgeMs;
  }
  let nowMs = Date.now();
  if (options.nowMs !== undefined) {
    nowMs = options.nowMs;
  }

  const logsDir = join(npmCacheDir, '_logs');
  if (isRealDirectory(logsDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(logsDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (name.endsWith('.log') === false) {
        continue;
      }
      const full = join(logsDir, name);
      try {
        const st = lstatSync(full, { throwIfNoEntry: false });
        if (
          st !== undefined &&
          st.isSymbolicLink() === false &&
          st.isFile() &&
          nowMs - st.mtimeMs >= maxLogAgeMs &&
          safeRemoveRegularFile(full)
        ) {
          removed.push(name);
        }
      } catch {
        // Ignore concurrent log removals.
      }
    }
  }

  const isOffline = options.offline === true;
  if (isOffline) {
    return removed;
  }
  const maxGb = readPositiveEnvInt('PYRIC_APPS_NPM_CACHE_MAX_GB', DEFAULT_NPM_CACHE_MAX_GB, env);
  let maxCacheBytes = maxGb * BYTES_PER_GIB;
  if (options.maxCacheBytes !== undefined) {
    maxCacheBytes = options.maxCacheBytes;
  }
  const cacacheDir = join(npmCacheDir, '_cacache');
  if (isRealDirectory(cacacheDir) === false || directoryBytes(cacacheDir) <= maxCacheBytes) {
    return removed;
  }
  if (hasSiblingHeavyRun(env)) {
    return removed;
  }
  let clean = defaultCleanNpmCache;
  if (options.cleanCache !== undefined) {
    clean = options.cleanCache;
  }
  try {
    clean(npmCacheDir);
    removed.push('_cacache');
  } catch {
    // Best-effort cache clean.
  }
  return removed;
}
