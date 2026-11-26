/**
 * Safe scratch directory lifecycle for `reproduce` tries (#1767).
 *
 * Enforces AGENTS.md Rule 8 before any `rmSync`:
 * 1. Target and its parent must be real directories (`lstatSync`, non-symlink)
 *    whose `realpathSync` sits strictly inside `~/.pyric/<subroot>` or
 *    `~/.cache/pyric-*`, refusing `/`, `/tmp`, `tmpdir()`, `/var/tmp`,
 *    `/private/tmp`, `/private/var/tmp`, `/run`, `/dev/shm`,
 *    `XDG_RUNTIME_DIR`, `$HOME`, `~/.cache`, and `~/.pyric`.
 * 2. Target must hold a regular, non-symlink `.pyric-job-tmp` ownership marker.
 */
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeNewFile } from './factory/host-files.ts';
import { restoreOwnerAccess } from './owner-access.ts';

export const REPRO_SCRATCH_MARKER = '.pyric-job-tmp';

const SHARED_SYSTEM_TEMP_DIRS: readonly string[] = [
  '/tmp',
  '/var/tmp',
  '/private/tmp',
  '/private/var/tmp',
  '/run',
  '/dev/shm',
];

function realPathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error) return null;
    throw error;
  }
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    return stat !== undefined && !stat.isSymbolicLink() && stat.isDirectory();
  } catch (error) {
    if (error instanceof Error && 'code' in error) return false;
    throw error;
  }
}

function isRegularNonSymlinkFile(path: string): boolean {
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    return stat !== undefined && !stat.isSymbolicLink() && stat.isFile();
  } catch (error) {
    if (error instanceof Error && 'code' in error) return false;
    throw error;
  }
}

function isEqualOrInside(basePath: string, candidateReal: string): boolean {
  const resolvedBase = realPathOrNull(basePath) ?? resolve(basePath);
  const rel = relative(resolvedBase, candidateReal);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isUnderAllowlistedRoot(candidateReal: string, homeDir: string): boolean {
  const homeReal = realPathOrNull(homeDir) ?? resolve(homeDir);
  const dotPyric = realPathOrNull(join(homeReal, '.pyric')) ?? join(homeReal, '.pyric');
  const relDotPyric = relative(dotPyric, candidateReal);
  if (relDotPyric !== '' && !relDotPyric.startsWith('..') && !isAbsolute(relDotPyric)) {
    const parts = relDotPyric.split(sep).filter((part) => part !== '');
    if (parts.length >= 2) return true;
  }

  const dotCache = realPathOrNull(join(homeReal, '.cache')) ?? join(homeReal, '.cache');
  const relCache = relative(dotCache, candidateReal);
  if (relCache !== '' && !relCache.startsWith('..') && !isAbsolute(relCache)) {
    const parts = relCache.split(sep).filter((part) => part !== '');
    const bucket = parts[0] ?? '';
    if (bucket.startsWith('pyric-') && bucket.length > 'pyric-'.length && parts.length >= 2) {
      return true;
    }
  }
  return false;
}

function isBlockedLocation(candidateReal: string, env: NodeJS.ProcessEnv): boolean {
  if (dirname(candidateReal) === candidateReal) return true;
  const homeDir = homedir();
  const homeReal = realPathOrNull(homeDir) ?? resolve(homeDir);
  const exactBlocked = [
    homeReal,
    dirname(homeReal),
    realPathOrNull(join(homeReal, '.cache')) ?? join(homeReal, '.cache'),
    realPathOrNull(join(homeReal, '.pyric')) ?? join(homeReal, '.pyric'),
  ];
  const osTmpReal = realPathOrNull(tmpdir()) ?? resolve(tmpdir());
  exactBlocked.push(osTmpReal);
  if (exactBlocked.includes(candidateReal)) return true;

  for (const shared of SHARED_SYSTEM_TEMP_DIRS) {
    if (isEqualOrInside(shared, candidateReal)) return true;
  }
  const xdg = env.XDG_RUNTIME_DIR?.trim();
  if (xdg !== undefined && xdg !== '' && isEqualOrInside(xdg, candidateReal)) {
    return true;
  }
  if (typeof process.getuid === 'function') {
    if (isEqualOrInside(`/run/user/${String(process.getuid())}`, candidateReal)) return true;
  }
  if (isEqualOrInside(osTmpReal, candidateReal)) {
    return true;
  }
  return false;
}

/** Stamps `.pyric-job-tmp` inside a newly created reproduction try scratch directory. */
export function stampReproTryMarker(dir: string): void {
  writeNewFile(join(dir, REPRO_SCRATCH_MARKER), `${String(process.pid)}\n`);
}

/**
 * Removes a finished reproduction try's scratch directory when it satisfies
 * both the allowlisted parent check (`~/.pyric/<subroot>` or `~/.cache/pyric-*`)
 * and the `.pyric-job-tmp` ownership marker check. Returns whether it was removed.
 */
export function removeReproTryScratch(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!existsSync(dir)) return false;
  if (!isRealDirectory(dir)) return false;
  const parent = dirname(resolve(dir));
  if (!isRealDirectory(parent)) return false;
  if (!isRegularNonSymlinkFile(join(dir, REPRO_SCRATCH_MARKER))) return false;

  const targetReal = realPathOrNull(dir);
  const parentReal = realPathOrNull(parent);
  if (targetReal === null || parentReal === null) return false;
  if (isBlockedLocation(targetReal, env) || isBlockedLocation(parentReal, env)) return false;

  const homeDir = homedir();
  if (!isUnderAllowlistedRoot(targetReal, homeDir)) return false;
  // Parent may be the subroot itself (e.g. ~/.cache/pyric-builders-repros) or deeper inside it.
  const dotCache = realPathOrNull(join(homeDir, '.cache')) ?? join(homeDir, '.cache');
  const dotPyric = realPathOrNull(join(homeDir, '.pyric')) ?? join(homeDir, '.pyric');
  const relCacheParent = relative(dotCache, parentReal);
  const relPyricParent = relative(dotPyric, parentReal);
  const cacheBucket = relCacheParent.split(sep)[0] ?? '';
  const validCacheParent =
    relCacheParent !== '' &&
    !relCacheParent.startsWith('..') &&
    !isAbsolute(relCacheParent) &&
    cacheBucket.startsWith('pyric-') &&
    cacheBucket.length > 'pyric-'.length;
  const validPyricParent =
    relPyricParent !== '' &&
    !relPyricParent.startsWith('..') &&
    !isAbsolute(relPyricParent);
  if (!validCacheParent && !validPyricParent) return false;

  try {
    restoreOwnerAccess(targetReal);
    rmSync(targetReal, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error) return false;
    throw error;
  }
}
