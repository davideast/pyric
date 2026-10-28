/**
 * A lock directory that lets one process at a time build into a shared
 * SharedWorker cache directory (see `worker-bundle-cache.ts`).
 *
 * The holder writes `owner.json` (pid, host, token) and refreshes the lock
 * directory's mtime every `heartbeatMs` while it holds the lock. A waiter
 * takes the lock over when:
 * - its owner is on this host and that pid has exited, or
 * - its mtime has not moved for `staleMs`: a crashed holder on another host,
 *   a holder that died between creating the directory and writing
 *   `owner.json`, or one whose event loop stalled past `staleMs`.
 *
 * The pid check is a fast path, not a guarantee. A reused pid looks alive, so
 * that lock waits for `staleMs`. A process in another pid namespace (a
 * container sharing the home directory) reports the same host name but a pid
 * this process cannot see, so the owner also records its pid namespace, and
 * the pid check runs only for an owner in this one. A lock from another pid
 * namespace, or from the Windows side of a WSL share, which records none, is
 * taken over only once it goes stale. Should a lock still be taken from a
 * live builder, that builder does not publish (`isHeld()`) and retries.
 *
 * `waitMs` is longer than `staleMs` on purpose: a waiter outlasts any lock
 * whose holder stopped refreshing it, so the wait limit fires only when a
 * live holder keeps its lock for longer than `waitMs`.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const LOCK_DIR = '.worker-build.lock';
export const ABANDONED_LOCK_PREFIX = `${LOCK_DIR}.abandoned-`;
const LOCK_OWNER_FILE = 'owner.json';

export interface WorkerBuildLockOptions {
  /** A lock whose mtime has not moved for this long is abandoned. */
  staleMs?: number;
  /** How often the holder refreshes the lock's mtime. */
  heartbeatMs?: number;
  /** How long to wait for another builder before failing. */
  waitMs?: number;
  pollMs?: number;
  /** Test seam for the rename that moves an abandoned lock aside. */
  renameLock?: (from: string, to: string) => void;
}

/** What the work running under the lock can ask of it. */
export interface WorkerBuildLock {
  /** False once another process has taken the lock over as abandoned. */
  isHeld(): boolean;
}

interface LockOwner {
  pid: number;
  host: string;
  /** `/proc/self/ns/pid` where there is one; the pid means nothing outside it. */
  pidNamespace?: string;
  token: string;
}

/** A lock, or a staging directory, untouched for this long belongs to a builder that is gone. */
export const WORKER_BUILD_STALE_MS = 60_000;
const DEFAULT_STALE_MS = WORKER_BUILD_STALE_MS;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_WAIT_MS = 150_000;
const DEFAULT_POLL_MS = 50;

/** Run `work` while holding the build lock of `outDir`. */
export async function withWorkerBuildLock<T>(
  outDir: string,
  work: (lock: WorkerBuildLock) => Promise<T>,
  options: WorkerBuildLockOptions = {},
): Promise<T> {
  mkdirSync(outDir, { recursive: true });
  const lockDir = join(outDir, LOCK_DIR);
  const owner = await acquire(lockDir, options);
  const heartbeat = startHeartbeat(lockDir, owner.token, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  try {
    return await work({ isHeld: () => isOwnedBy(lockDir, owner.token) });
  } finally {
    clearInterval(heartbeat);
    release(lockDir, owner.token);
  }
}

async function acquire(lockDir: string, options: WorkerBuildLockOptions): Promise<LockOwner> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const owner: LockOwner = { pid: process.pid, host: hostname(), pidNamespace: PID_NAMESPACE, token: randomBytes(8).toString('hex') };
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (tryCreate(lockDir, owner)) return owner;
    const brokeAbandonedLock = isAbandoned(lockDir, staleMs) && breakLock(lockDir, options.renameLock ?? renameSync);
    if (brokeAbandonedLock) continue;
    const hasWaitedTooLong = Date.now() >= deadline;
    if (hasWaitedTooLong) {
      throw new Error(
        `pyric sandbox: waited ${Math.round(waitMs / 1000)}s for another process to build the SharedWorker bundle; remove ${lockDir} if no pyric process is running.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function tryCreate(lockDir: string, owner: LockOwner): boolean {
  try {
    mkdirSync(lockDir);
  } catch (error) {
    const isHeld = (error as NodeJS.ErrnoException).code === 'EEXIST';
    if (isHeld) return false;
    throw error;
  }
  try {
    writeFileSync(join(lockDir, LOCK_OWNER_FILE), JSON.stringify(owner));
  } catch (error) {
    rmSync(lockDir, { recursive: true, force: true });
    throw error;
  }
  return true;
}

function readOwner(lockDir: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, LOCK_OWNER_FILE), 'utf8')) as LockOwner;
  } catch {
    return null;
  }
}

function isOwnedBy(lockDir: string, token: string): boolean {
  return readOwner(lockDir)?.token === token;
}

/** This process's pid namespace on Linux; undefined where there is no `/proc`, as on macOS. */
function readPidNamespace(): string | undefined {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return undefined;
  }
}

const PID_NAMESPACE = readPidNamespace();

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isAbandoned(lockDir: string, staleMs: number): boolean {
  const owner = readOwner(lockDir);
  const seesOwnerPid = owner !== null && owner.host === hostname() && owner.pidNamespace === PID_NAMESPACE;
  if (seesOwnerPid && !isProcessAlive(owner.pid)) return true;
  try {
    return Date.now() - statSync(lockDir).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * Move an abandoned lock aside, then remove it, so two breakers never both
 * delete. Returns whether this call moved it. A lock that is already gone
 * returns false, and the caller waits a poll before trying again. Any other
 * failure (a cache directory this user cannot write) cannot be waited out.
 */
function breakLock(lockDir: string, rename: (from: string, to: string) => void): boolean {
  const aside = `${lockDir}.abandoned-${randomBytes(4).toString('hex')}`;
  try {
    rename(lockDir, aside);
  } catch (error) {
    const isAlreadyGone = (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (isAlreadyGone) return false;
    throw new Error(`pyric sandbox: cannot remove the abandoned SharedWorker build lock ${lockDir}: ${String(error)}`);
  }
  rmSync(aside, { recursive: true, force: true });
  return true;
}

function startHeartbeat(lockDir: string, token: string, heartbeatMs: number): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    if (!isOwnedBy(lockDir, token)) return;
    const now = new Date();
    try {
      utimesSync(lockDir, now, now);
    } catch {
      // The lock was taken over; isHeld() reports it.
    }
  }, heartbeatMs);
  timer.unref?.();
  return timer;
}

/** Remove the lock if it is still ours. A failure here never hides a finished build. */
function release(lockDir: string, token: string): void {
  if (!isOwnedBy(lockDir, token)) return;
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Left behind, it is taken over once its pid has exited or it goes stale.
  }
}
