/**
 * Which request paths the hosting plane never serves (#1779).
 *
 * Production Hosting serves only what `firebase deploy` uploaded, and the
 * `ignore` list `firebase init` writes leaves out `firebase.json`, every file
 * or directory whose name starts with a period, and `node_modules`:
 * https://firebase.google.com/docs/hosting/full-config#ignore
 *
 * `pyric sandbox` applies that default to every project, whatever its
 * `hosting.ignore` says, because a project with no `hosting` block (or
 * `"public": "."`) serves the project directory itself, and that directory
 * holds `.pyric/state` (users and data), `.env` files and credentials. The
 * check fails closed: a path that does not decode, or carries a backslash or
 * a NUL, is refused too.
 */

const IGNORED_ROOT_FILE = 'firebase.json';
const IGNORED_DIRECTORY = 'node_modules';

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
  const hasIgnoredSegment = segments.some((segment) => isDotSegment(segment) || isNodeModules(segment));
  return hasIgnoredSegment || isRootFirebaseJson(segments);
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
