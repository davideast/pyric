/**
 * The on-disk cache of the SharedWorker bundle, safe to share between processes.
 *
 * The Vite plugin caches the worker under `~/.pyric/vite-worker/<hash>`, one
 * directory for every project, worktree and test run on the machine that has
 * the same CLI source. Builders used to write `worker.js`, its epoch and its
 * marker in place, so two builders in one directory read each other's
 * half-written output: one failed with "omitted its epoch placeholder", and
 * another returned an epoch that matched no `worker.js` on disk.
 *
 * Three rules keep a shared directory consistent:
 * - one builder at a time, under a lock directory that a crashed or killed
 *   holder cannot keep forever;
 * - each build writes into a private staging directory, then renames its
 *   files into place with the marker last;
 * - a reader trusts the cache only when `worker.js` carries the epoch the
 *   epoch file names, so any torn pair reads as a miss and is rebuilt.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const WORKER_FILE = 'worker.js';
export const WORKER_EPOCH_FILE = '.worker-epoch';
const WORKER_MARKER_FILE = '.worker-complete';
const WORKER_MAP_FILE = 'worker.js.map';
const LOCK_DIR = '.worker-build.lock';
const LOCK_OWNER_FILE = 'owner.json';
const EPOCH_PATTERN = /^[a-f0-9]{16}$/;

export interface WorkerBuildLockOptions {
  /** A lock older than this is abandoned, whoever holds it. */
  staleMs?: number;
  /** How long to wait for another builder before failing. */
  waitMs?: number;
  pollMs?: number;
}

interface LockOwner {
  pid: number;
  host: string;
  token: string;
}

/** The epoch of a complete, self-consistent bundle for `hash`, or null. */
export function readCompletedWorkerBundle(outDir: string, hash: string): string | null {
  try {
    const hasMatchingMarker = readFileSync(join(outDir, WORKER_MARKER_FILE), 'utf8') === hash;
    if (!hasMatchingMarker) return null;
    const epoch = readFileSync(join(outDir, WORKER_EPOCH_FILE), 'utf8').trim();
    const hasValidEpoch = EPOCH_PATTERN.test(epoch);
    if (!hasValidEpoch) return null;
    const workerCarriesEpoch = readFileSync(join(outDir, WORKER_FILE), 'utf8').includes(epoch);
    return workerCarriesEpoch ? epoch : null;
  } catch {
    return null;
  }
}

/**
 * Move a finished build into `outDir`. Each rename replaces one file whole.
 * The old marker goes first and the new one last, so the marker never vouches
 * for a mix of two builds.
 */
export function publishWorkerBundle(stagingDir: string, outDir: string, hash: string): void {
  rmSync(join(outDir, WORKER_MARKER_FILE), { force: true });
  writeFileSync(join(stagingDir, WORKER_MARKER_FILE), hash);
  for (const name of [WORKER_MAP_FILE, WORKER_FILE, WORKER_EPOCH_FILE, WORKER_MARKER_FILE]) {
    const staged = join(stagingDir, name);
    if (existsSync(staged)) renameSync(staged, join(outDir, name));
  }
}

/** Run `work` while holding the build lock of `outDir`. */
export async function withWorkerBuildLock<T>(
  outDir: string,
  work: () => Promise<T>,
  options: WorkerBuildLockOptions = {},
): Promise<T> {
  mkdirSync(outDir, { recursive: true });
  const release = await acquireWorkerBuildLock(join(outDir, LOCK_DIR), options);
  try {
    return await work();
  } finally {
    release();
  }
}

async function acquireWorkerBuildLock(lockDir: string, options: WorkerBuildLockOptions): Promise<() => void> {
  const staleMs = options.staleMs ?? 120_000;
  const waitMs = options.waitMs ?? 150_000;
  const pollMs = options.pollMs ?? 50;
  const owner: LockOwner = { pid: process.pid, host: hostname(), token: randomBytes(8).toString('hex') };
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (tryCreateLock(lockDir, owner)) return () => releaseLock(lockDir, owner.token);
    if (isLockAbandoned(lockDir, staleMs)) {
      breakLock(lockDir);
      continue;
    }
    const hasWaitedTooLong = Date.now() >= deadline;
    if (hasWaitedTooLong) {
      throw new Error(
        `pyric sandbox: waited ${Math.round(waitMs / 1000)}s for another process to build the SharedWorker bundle; remove ${lockDir} if no pyric process is running.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function tryCreateLock(lockDir: string, owner: LockOwner): boolean {
  try {
    mkdirSync(lockDir);
  } catch (error) {
    const isHeld = (error as NodeJS.ErrnoException).code === 'EEXIST';
    if (isHeld) return false;
    throw error;
  }
  writeFileSync(join(lockDir, LOCK_OWNER_FILE), JSON.stringify(owner));
  return true;
}

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, LOCK_OWNER_FILE), 'utf8')) as LockOwner;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Abandoned: its holder on this host has exited, or it outlived `staleMs`. */
function isLockAbandoned(lockDir: string, staleMs: number): boolean {
  const owner = readLockOwner(lockDir);
  const isOwnerOnThisHost = owner !== null && owner.host === hostname();
  if (isOwnerOnThisHost && !isProcessAlive(owner.pid)) return true;
  try {
    return Date.now() - statSync(lockDir).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * Move the lock aside, then remove it, so two breakers never both delete.
 * A breaker that loses a race with a fresh holder costs one duplicate build,
 * which staging and the reader's epoch check keep harmless.
 */
function breakLock(lockDir: string): void {
  const aside = `${lockDir}.abandoned-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(lockDir, aside);
  } catch {
    return;
  }
  rmSync(aside, { recursive: true, force: true });
}

function releaseLock(lockDir: string, token: string): void {
  const isStillOurs = readLockOwner(lockDir)?.token === token;
  if (!isStillOurs) return;
  rmSync(lockDir, { recursive: true, force: true });
}
