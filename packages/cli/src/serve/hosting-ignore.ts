/**
 * Which request paths the hosting plane never serves (#1779).
 *
 * Production Hosting serves only what `firebase deploy` uploaded, and the
 * `ignore` list `firebase init` writes leaves out `firebase.json`, every file
 * or directory whose name starts with a period, and `node_modules`:
 * https://firebase.google.com/docs/hosting/full-config#ignore
 *
 * `pyric sandbox` applies that default to every project, whatever its
 * `hosting.ignore` says, because a public directory such as `"."` holds
 * `.pyric/state` (users and data), `.env` files and credentials. So
 * `/.well-known/` gets 404 too, as it does from a default deploy. If a
 * project's own `ignore` globs are ever honored, the refusals of `.pyric`,
 * `.env` and `node_modules` stay unconditional, whatever those globs say.
 *
 * The check fails closed. A path that does not decode, or carries a
 * backslash, a NUL, a `:` (an NTFS alternate data stream), a segment ending
 * in a period or space, or an 8.3 short name such as `PYRIC~1` is refused,
 * because Windows opens each of those as some other name. After a path
 * resolves, the file's real path is checked again, so a symlink inside the
 * public directory cannot reach an ignored file.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

const IGNORED_ROOT_FILE = 'firebase.json';
const IGNORED_DIRECTORY = 'node_modules';
/** An 8.3 short name, which Windows opens as the long name it abbreviates. */
const SHORT_NAME = /^[^.]{1,6}~\d/;

/** Split a decoded path into its segments on `/` and `\`, dropping empty ones. */
function pathSegments(decodedPath: string): string[] {
  return decodedPath.split(/[/\\]/).filter((segment) => segment !== '');
}

function isDotSegment(segment: string): boolean {
  return segment.startsWith('.');
}

/** Case-insensitive, because a case-insensitive disk (macOS, Windows) opens `NODE_MODULES` as `node_modules`. */
function isNodeModules(segment: string): boolean {
  return segment.toLowerCase() === IGNORED_DIRECTORY;
}

/** Windows trims a trailing period or space, reads `:` as a stream name, and resolves short names. */
function isWindowsAlias(segment: string): boolean {
  const hasTrailingTrim = segment.endsWith('.') || segment.endsWith(' ');
  return hasTrailingTrim || segment.includes(':') || SHORT_NAME.test(segment);
}

function isIgnoredSegment(segment: string): boolean {
  return isDotSegment(segment) || isNodeModules(segment) || isWindowsAlias(segment);
}

function isRootFirebaseJson(segments: readonly string[]): boolean {
  const isSingleSegment = segments.length === 1;
  return isSingleSegment && segments[0]?.toLowerCase() === IGNORED_ROOT_FILE;
}

/**
 * True when a decoded request path names something production Hosting would
 * not have deployed. Every segment counts, so `/.pyric/state/x`,
 * `/assets/.env` and `/a/node_modules/b` are all ignored.
 */
export function isHostingIgnoredDecodedPath(decodedPath: string): boolean {
  const hasUnsafeCharacter = decodedPath.includes('\\') || decodedPath.includes('\0');
  if (hasUnsafeCharacter) return true;
  const segments = pathSegments(decodedPath);
  return segments.some(isIgnoredSegment) || isRootFirebaseJson(segments);
}

/**
 * True when a raw (still percent-encoded) URL pathname names something the
 * hosting plane must not serve. A pathname that does not decode is ignored.
 */
export function isHostingIgnoredPathname(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return isHostingIgnoredDecodedPath(decoded);
}

/**
 * True when `file`, after following every link, lies outside `publicDir`'s
 * real path or at an ignored path inside it. A path that cannot be resolved
 * is refused.
 */
export function isHostingIgnoredRealFile(publicDir: string, file: string): boolean {
  let fromRoot: string;
  try {
    fromRoot = relative(realpathSync.native(publicDir), realpathSync.native(file));
  } catch {
    return true;
  }
  const leavesRoot = fromRoot.startsWith('..') || isAbsolute(fromRoot);
  if (leavesRoot) return true;
  const portablePath = fromRoot.split('\\').join('/');
  return isHostingIgnoredDecodedPath(portablePath);
}
