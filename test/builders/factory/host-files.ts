/**
 * How the harness writes files on the host during a factory run. Every
 * session's sandbox can write the run directory, and they run at once, so a
 * session can plant a symlink at any path in it, pointing at a file of the
 * host's (`ln -sf <credential file> <run>/hosts`). A host write that
 * followed it would overwrite that file. So:
 *
 * - What only the harness writes lives in the run's host directory,
 *   `<run dir>.host/` beside the run directory, which no sandbox binds
 *   writable (`hostDir`). A file a sandbox must read is bound read-only
 *   from there.
 * - Every host write opens its file with `O_NOFOLLOW`, and a new file also
 *   with `O_EXCL`, so a planted link fails the write instead of redirecting
 *   it, wherever the file is.
 * - A shared file the harness replaces inside the run directory (the
 *   latest check) is written to a fresh, unguessable sibling with `O_EXCL`
 *   and renamed over the old one; a rename replaces a link, never follows it.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const APPEND = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW;

/** The run's host directory: beside the run directory, never inside it. */
export function hostDirOf(runDir: string): string {
  return `${runDir}.host`;
}

export function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class HostFileError extends Error {}

/**
 * Makes `dir` and checks every part of it from `base` down is a real
 * directory, not a link, and that it is not inside the run directory.
 * `base` itself is the harness's: the run's host directory.
 */
export function makeHostDir(dir: string, base: string, runDir: string): string {
  if (!isInside(dir, base)) throw new HostFileError(`${dir} is not inside the run's host directory ${base}`);
  if (isInside(dir, runDir) || isInside(runDir, dir)) throw new HostFileError(`${dir} overlaps the run directory ${runDir}, which sessions can write`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const parts = relative(base, dir).split('/').filter((part) => part !== '');
  const chain = [base, ...parts.map((_, index) => join(base, ...parts.slice(0, index + 1)))];
  for (const path of chain) {
    const isRealDirectory = lstatSync(path).isDirectory();
    if (!isRealDirectory) throw new HostFileError(`${path} is not a directory of the harness's own`);
  }
  return dir;
}

/** Opens a file that must not exist yet, never through a link. */
export function openNewFile(path: string): number {
  try {
    return openSync(path, NEW_FILE, 0o600);
  } catch (error) {
    throw new HostFileError(`refusing to write ${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}; it already exists or is a link`);
  }
}

function writeAll(fd: number, text: string): void {
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** Writes a file that must not exist yet. */
export function writeNewFile(path: string, text: string): void {
  writeAll(openNewFile(path), text);
}

/** Appends to a file, making it when it isn't there, never through a link. */
export function appendFile(path: string, text: string): void {
  let fd: number;
  try {
    fd = openSync(path, APPEND, 0o600);
  } catch (error) {
    throw new HostFileError(`refusing to append to ${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  writeAll(fd, text);
}

const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** The largest shared file the harness reads from the run directory. */
export const MAX_RUN_FILE_BYTES = 4 * 1024 * 1024;

export type RunFileRead = { ok: true; text: string } | { ok: false; problem: string };

/**
 * Reads a file a session writes, never through a link, and only a regular
 * file of at most `MAX_RUN_FILE_BYTES`: a link to a host file, a FIFO or a
 * device is refused, so a session can't make the harness read a host file
 * into its log or hang on a read.
 */
export function readRunFile(path: string): RunFileRead {
  let fd: number;
  try {
    fd = openSync(path, READ);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, problem: code === 'ELOOP' ? 'it is a link' : `it can't be opened (${code ?? 'error'})` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, problem: 'it is not a regular file' };
    if (stat.size > MAX_RUN_FILE_BYTES) return { ok: false, problem: `it is over ${MAX_RUN_FILE_BYTES} bytes` };
    return { ok: true, text: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

/** Replaces `path` whole: a fresh sibling with an unguessable name, then a rename over it. Safe in a directory a sandbox writes. */
export function replaceFile(path: string, text: string): void {
  const partial = join(dirname(path), `.${randomBytes(12).toString('hex')}.partial`);
  writeNewFile(partial, text);
  renameSync(partial, path);
}
