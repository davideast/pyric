/**
 * The sandbox runs its processes as uid 0 of its own user namespace, which
 * is the harness's own uid on the host, so a builder can take the owner's
 * permissions away from anything in the run root: `chmod 000 logs`, `chmod
 * 444 network.jsonl`. Once the sandbox has stopped, and before the harness
 * reads, merges or copies anything, it gives the owner back read and write
 * on every file and read, write and search on every directory, following
 * no link. The app's installed packages are left alone: nothing reads them.
 *
 * A chmod that still fails leaves the file as it was; the harness then skips
 * that file and records why (`run-finish.ts`).
 */
import { chmodSync, lstatSync, readdirSync, type Stats } from 'node:fs';
import { join } from 'node:path';

const OWNER_FILE = 0o600;
const OWNER_DIRECTORY = 0o700;

/** The owner bits `stat` should have; undefined for a link or anything but a file or a directory. */
function ownerBits(stat: Stats): number | undefined {
  if (stat.isSymbolicLink()) return undefined;
  if (stat.isDirectory()) return OWNER_DIRECTORY;
  return stat.isFile() ? OWNER_FILE : undefined;
}

function lstatIfPossible(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function chmodIfPossible(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Left as it was: the harness skips what it then can't touch.
  }
}

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Gives the owner back access to `path` and, for a directory, everything under it but `skip`. */
export function restoreOwnerAccess(path: string, skip: ReadonlySet<string> = new Set()): void {
  if (skip.has(path)) return;
  const stat = lstatIfPossible(path);
  const wanted = stat === undefined ? undefined : ownerBits(stat);
  if (stat === undefined || wanted === undefined) return;
  const lacksAccess = (stat.mode & wanted) !== wanted;
  if (lacksAccess) chmodIfPossible(path, (stat.mode & 0o7777) | wanted);
  if (!stat.isDirectory()) return;
  for (const name of namesIn(path)) restoreOwnerAccess(join(path, name), skip);
}
