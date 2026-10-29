/**
 * The files a packed Pyric tarball holds, and a check that an installed
 * package holds exactly those files (#1596, #1585).
 *
 * The check compares each file's path and size. That is cheap enough to run
 * on every set, about 20 ms for all of a set's Pyric packages, and it catches
 * what a stale or incomplete install leaves: a missing `dist/`, a file only
 * one build has, a file of another length. A tree the store makes from a
 * tarball is extracted from it, so its bytes are the tarball's.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** One regular file in a tarball, its path under the package directory. */
interface TarFile {
  path: string;
  body: Buffer;
}

const BLOCK = 512;

/** Tar entry types that are a regular file. */
const REGULAR_TYPES = new Set(['0', '\0', '7']);

/** A pax extended header (`x`) or a GNU long name (`L`) names the entry after it. */
const LONG_NAME_TYPES = new Set(['x', 'L']);

/** How many of one package's differences a failure lists before it counts the rest. */
const LISTED_PROBLEMS = 5;

/** A NUL-terminated string field of a tar header. */
function headerField(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

/** The `path` record of a pax extended header's body, if it has one. */
function paxPath(body: Buffer): string | undefined {
  const record = body.toString('utf8').split('\n').find((line) => / path=/.test(line));
  return record?.slice(record.indexOf('=') + 1);
}

function longName(type: string, body: Buffer): string | undefined {
  if (type === 'x') return paxPath(body);
  return headerField(body, 0, body.length);
}

/** A path with its first part dropped, as npm extracts a tarball: `package/dist/a.js` is `dist/a.js`. */
function underPackage(path: string): string | undefined {
  const slash = path.indexOf('/');
  const rest = slash === -1 ? '' : path.slice(slash + 1);
  return rest === '' ? undefined : rest;
}

/** The regular files of an uncompressed tar, as `npm pack` writes one. */
export function tarFiles(tar: Buffer): TarFile[] {
  const files: TarFile[] = [];
  let offset = 0;
  let nextName: string | undefined;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    const name = headerField(header, 0, 100);
    if (name === '') break;
    const prefix = headerField(header, 345, 155);
    const type = headerField(header, 156, 1) || '\0';
    const size = Number.parseInt(headerField(header, 124, 12).trim() || '0', 8);
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (LONG_NAME_TYPES.has(type)) {
      nextName = longName(type, body);
      continue;
    }
    const path = underPackage(nextName ?? (prefix === '' ? name : `${prefix}/${name}`));
    nextName = undefined;
    if (REGULAR_TYPES.has(type) && path !== undefined) files.push({ path, body });
  }
  return files;
}

/** Each file under an installed package's directory, by path, with its size; its own `node_modules` holds other packages and is left out. */
function installedSizes(dir: string): Map<string, number> {
  const sizes = new Map<string, number>();
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const isNestedPackages = at === dir && entry.name === 'node_modules';
      if (entry.isDirectory() && !isNestedPackages) walk(path);
      if (entry.isFile()) sizes.set(relative(dir, path), statSync(path).size);
    }
  };
  walk(dir);
  return sizes;
}

/** Up to LISTED_PROBLEMS lines, and a count of the rest. */
function listed(problems: string[]): string[] {
  const rest = problems.length - LISTED_PROBLEMS;
  return rest > 0 ? [...problems.slice(0, LISTED_PROBLEMS), `and ${rest} more`] : problems;
}

/**
 * How the package installed in `dir` differs from its tarball's files, one
 * line each; none when it holds exactly those files, each at its size.
 */
export function installedFileProblems(dir: string, expected: ReadonlyMap<string, number>): string[] {
  if (!existsSync(dir)) return ['not installed'];
  const installed = installedSizes(dir);
  const problems: string[] = [];
  for (const [path, size] of expected) {
    const actual = installed.get(path);
    if (actual === undefined) problems.push(`missing ${path}`);
    else if (actual !== size) problems.push(`${path} is ${actual} bytes, the tarball's is ${size}`);
  }
  for (const path of installed.keys()) {
    if (!expected.has(path)) problems.push(`${path} is not in the tarball`);
  }
  return listed(problems);
}
