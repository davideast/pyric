import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCK_DIR } from './worker-build-lock.js';

const DEFAULT_VITE_WORKER_MAX_ENTRIES = 8;
const DEFAULT_SERVE_CACHE_MAX_ENTRIES = 16;
const DEFAULT_SALTED_WORKER_MAX_ENTRIES = 8;
const DEFAULT_MIN_EVICT_AGE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SALTED_MIN_EVICT_AGE_MS = 30 * 60 * 1000;
const SALTED_WORKER_MARKER = '.salted-worker';

interface ServeCacheEvictOptions {
  maxEntries?: number;
  minAgeMs?: number;
  nowMs?: number;
}

interface ViteWorkerEvictOptions {
  maxEntries?: number;
  saltedMaxEntries?: number;
  minAgeMs?: number;
  saltedMinAgeMs?: number;
  nowMs?: number;
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

function entryMtimeMs(path: string): number | null {
  try {
    const st = statSync(path, { throwIfNoEntry: false });
    if (st === undefined || st.isDirectory() === false) {
      return null;
    }
    return st.mtimeMs;
  } catch {
    return null;
  }
}

function safeRemoveDir(path: string): boolean {
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
  if (existsSync(cacheRoot) === false) {
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
      let noCacheMaxAgeMs = staleNoCacheMs;
      if (existsSync(join(full, 'sdk', '.complete'))) {
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
  if (existsSync(cacheRoot) === false) {
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
    } else {
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

export function evictStandaloneTempDirs(
  tmpRoot: string,
  keepName: string,
  minAgeMs = DEFAULT_MIN_EVICT_AGE_MS,
  nowMs = Date.now(),
): string[] {
  const removed: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(tmpRoot);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (name === keepName || name.startsWith('pyric-serve-') === false) {
      continue;
    }
    const full = join(tmpRoot, name);
    const mtimeMs = entryMtimeMs(full);
    if (mtimeMs !== null && nowMs - mtimeMs >= minAgeMs && safeRemoveDir(full)) {
      removed.push(name);
    }
  }
  return removed;
}
