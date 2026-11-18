import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HELD_SLOT_ENV, isStale, slotDirectory, type SlotHolder } from '../../scripts/lib/heavy-run-slots.ts';

const DEFAULT_DEPS_MAX_ENTRIES = 12;
const DEFAULT_DEPS_MIN_IDLE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_STALE_WARM_MS = 2 * 60 * 60 * 1000;
const DEFAULT_NPM_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NPM_CACHE_MAX_GB = 8;
const BYTES_PER_GIB = 1024 * 1024 * 1024;
const STORE_RECORD_FILE = 'store.json';
const SLOT_LOCK_PATTERN = /^slot-\d+\.lock$/;

interface DependencyStorePruneOptions {
  maxEntries?: number;
  minIdleMs?: number;
  staleWarmMs?: number;
  nowMs?: number;
}

interface NpmCachePruneOptions {
  maxLogAgeMs?: number;
  maxCacheBytes?: number;
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  cleanCache?: (npmCacheDir: string) => void;
  nowMs?: number;
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

function safeRemove(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function touchDependencyStoreEntry(entryDir: string, nowMs = Date.now()): void {
  try {
    const secs = nowMs / 1000;
    const recordPath = join(entryDir, STORE_RECORD_FILE);
    if (existsSync(recordPath)) {
      utimesSync(recordPath, secs, secs);
    }
    utimesSync(entryDir, secs, secs);
  } catch {
    // Best-effort recency stamp on store hit.
  }
}

function readEntryFormat(entryDir: string): number | null {
  try {
    const raw = readFileSync(join(entryDir, STORE_RECORD_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { format?: unknown };
    if (typeof parsed.format === 'number') {
      return parsed.format;
    }
    return null;
  } catch {
    return null;
  }
}

function readEntryLastUsedMs(entryDir: string): number | null {
  try {
    const recordStat = statSync(join(entryDir, STORE_RECORD_FILE), { throwIfNoEntry: false });
    if (recordStat !== undefined) {
      return recordStat.mtimeMs;
    }
    const dirStat = statSync(entryDir, { throwIfNoEntry: false });
    if (dirStat !== undefined && dirStat.isDirectory()) {
      return dirStat.mtimeMs;
    }
    return null;
  } catch {
    return null;
  }
}

export function pruneDependencyStore(
  storeDir: string,
  currentFormat: number,
  options: DependencyStorePruneOptions = {},
): string[] {
  const removed: string[] = [];
  if (existsSync(storeDir) === false) {
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
      const warmStat = statSync(full, { throwIfNoEntry: false });
      if (warmStat !== undefined && warmStat.isDirectory() && nowMs - warmStat.mtimeMs >= staleWarmMs && safeRemove(full)) {
        removed.push(name);
      }
      continue;
    }
    if (name.startsWith('.')) {
      continue;
    }
    const mtimeMs = readEntryLastUsedMs(full);
    if (mtimeMs === null) {
      continue;
    }
    const format = readEntryFormat(full);
    if (format !== null && format !== currentFormat) {
      if (nowMs - mtimeMs >= minIdleMs && safeRemove(full)) {
        removed.push(name);
      }
      continue;
    }
    activeEntries.push({ name, full, mtimeMs });
  }

  activeEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of activeEntries.slice(maxEntries)) {
    if (nowMs - entry.mtimeMs >= minIdleMs && safeRemove(entry.full)) {
      removed.push(entry.name);
    }
  }
  return removed;
}

function directoryBytes(root: string): number {
  if (existsSync(root) === false) {
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
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const st = statSync(full, { throwIfNoEntry: false });
          if (st !== undefined) {
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
  if (existsSync(logsDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(logsDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const full = join(logsDir, name);
      try {
        const st = statSync(full, { throwIfNoEntry: false });
        if (st !== undefined && nowMs - st.mtimeMs >= maxLogAgeMs && safeRemove(full)) {
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
  if (directoryBytes(cacacheDir) <= maxCacheBytes) {
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
