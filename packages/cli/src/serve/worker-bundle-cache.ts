/**
 * The on-disk cache of the SharedWorker bundle, safe to share between processes.
 *
 * The Vite plugin caches the worker under `~/.pyric/vite-worker/<hash>`, one
 * directory for every project, worktree and test run on the machine that has
 * the same CLI source. Builders used to write `worker.js`, its epoch and its
 * marker in place, so two builders in one directory read each other's
 * half-written output: one failed with "omitted its epoch placeholder", and
 * another returned an epoch that matched no `worker.js` on disk (#1214).
 *
 * Three rules keep a shared directory consistent:
 * - one builder at a time, under the lock in `worker-build-lock.ts`;
 * - each build writes into a private staging directory, then renames its
 *   files into place;
 * - a reader trusts the cache only when `worker.js` carries the epoch the
 *   epoch file names, so any torn pair reads as a miss and is rebuilt.
 *
 * The last rule is what keeps readers consistent. The marker only records
 * which source hash the bundle was built from; removing it before a publish
 * and writing it last narrows the window in which it names a half-published
 * bundle, but a reader does not rely on that.
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { ABANDONED_LOCK_PREFIX } from './worker-build-lock.js';

export const WORKER_FILE = 'worker.js';
export const WORKER_EPOCH_FILE = '.worker-epoch';
const WORKER_MARKER_FILE = '.worker-complete';
const WORKER_MAP_FILE = 'worker.js.map';
const EPOCH_PATTERN = /^[a-f0-9]{16}$/;

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

/** The prefix of the staging directories builds of `outDir` use, beside it. */
function stagingPrefix(outDir: string): string {
  return `.${basename(outDir)}.worker-`;
}

/** Where a build of `outDir` writes before it publishes: a sibling, so sourcemap paths stay correct. */
export function stagingPathPrefix(outDir: string): string {
  return join(dirname(outDir), stagingPrefix(outDir));
}

/**
 * Remove what earlier builders left when they were killed: staging
 * directories beside `outDir` and abandoned locks inside it. Only the lock
 * holder calls this, so no live build owns them.
 */
export function removeBuildLeftovers(outDir: string): void {
  const parent = dirname(outDir);
  const staged = readdirSync(parent).filter((name) => name.startsWith(stagingPrefix(outDir)));
  for (const name of staged) rmSync(join(parent, name), { recursive: true, force: true });
  const abandoned = readdirSync(outDir).filter((name) => name.startsWith(ABANDONED_LOCK_PREFIX));
  for (const name of abandoned) rmSync(join(outDir, name), { recursive: true, force: true });
}

/** Move a finished build into `outDir`. Each rename replaces one file whole. */
export function publishWorkerBundle(stagingDir: string, outDir: string, hash: string): void {
  rmSync(join(outDir, WORKER_MARKER_FILE), { force: true });
  writeFileSync(join(stagingDir, WORKER_MARKER_FILE), hash);
  for (const name of [WORKER_FILE, WORKER_MAP_FILE, WORKER_EPOCH_FILE, WORKER_MARKER_FILE]) {
    const staged = join(stagingDir, name);
    if (existsSync(staged)) renameSync(staged, join(outDir, name));
  }
}
