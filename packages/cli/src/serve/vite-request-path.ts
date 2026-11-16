/**
 * Request pathname canonicalization for Vite dev server security guards.
 *
 * Vite's raw-fs and static middlewares run after transform middleware and
 * normalize `req.url` with `new URL(req.url.replace(/^\/{2,}/, '/'), ...)`
 * before decoding. Pre-middlewares that check `req.url` before Vite must
 * therefore evaluate every pathname form Vite or `base` stripping can resolve
 * a request to, including repeated leading slashes, dot segments, backslashes,
 * and percent-encoded equivalents.
 */
import path from 'node:path';

const FS_PREFIX = '/@fs/';
const ID_PREFIX = '/@id/';
const ORIGIN = 'http://request.invalid';
const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\//;
const NON_CANONICAL_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i;
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;
const MAX_ID_UNWRAPS = 8;

/** Vite's `base` as a pathname with a trailing slash; a full URL contributes its pathname. */
export function viteBasePrefix(base: string): string {
  const pathname = new URL(base, 'http://base.invalid').pathname;
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

/** Extracts the raw pathname from a request target, without query or hash. */
export function rawRequestPathname(rawUrl: string | undefined): string {
  const input = rawUrl ?? '/';
  if (SCHEME_PREFIX.test(input)) {
    try {
      return new URL(input).pathname;
    } catch {
      return input.replace(/[?#].*$/, '');
    }
  }
  return input.replace(/[?#].*$/, '');
}

/** Collapses leading slashes and backslashes so `new URL` never parses a path segment as a host. */
function sanitizeLeadingSlashes(pathname: string): string {
  const withForwardSlashes = pathname.replace(/\\/g, '/');
  return `/${withForwardSlashes.replace(/^\/+/, '')}`;
}

function addNormalizedForms(candidate: string, out: Set<string>): void {
  const slashed = sanitizeLeadingSlashes(candidate);
  out.add(slashed);
  out.add(sanitizeLeadingSlashes(path.posix.normalize(slashed)));
  out.add(sanitizeLeadingSlashes(path.posix.normalize(slashed.replace(/\/{2,}/g, '/'))));
}

function normalizeAlreadyDecodedPath(decoded: string): string[] {
  const variants = new Set<string>();
  try {
    const whatwg = new URL(sanitizeLeadingSlashes(decoded), ORIGIN).pathname;
    addNormalizedForms(whatwg, variants);
  } catch {
    // Keep the POSIX-normalized forms below even if WHATWG parsing rejects a character.
  }
  addNormalizedForms(decoded, variants);
  return [...variants];
}

function normalizeRawPath(rawPath: string): string[] | null {
  let decodedRaw: string;
  try {
    decodedRaw = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decodedRaw.includes('\0')) return null;

  const variants = new Set<string>();
  try {
    const whatwgRaw = new URL(sanitizeLeadingSlashes(rawPath), ORIGIN).pathname;
    const decodedWhatwg = decodeURIComponent(whatwgRaw);
    if (decodedWhatwg.includes('\0')) return null;
    addNormalizedForms(decodedWhatwg, variants);
  } catch {
    return null;
  }

  for (const variant of normalizeAlreadyDecodedPath(decodedRaw)) {
    variants.add(variant);
  }
  return [...variants];
}

/**
 * Every decoded, normalized pathname a Vite dev server request can resolve to,
 * both with and without Vite's configured `base`. Returns null when the path
 * fails to decode or contains a null byte.
 */
export function viteRequestPathnames(rawUrl: string | undefined, base: string): string[] | null {
  const rawPath = rawRequestPathname(rawUrl);
  const normalized = normalizeRawPath(rawPath);
  if (normalized === null) return null;

  const prefix = viteBasePrefix(base);
  if (prefix === '/') return normalized;

  const all = new Set<string>(normalized);
  if (rawPath.startsWith(prefix)) {
    const strippedRaw = normalizeRawPath(`/${rawPath.slice(prefix.length)}`);
    if (strippedRaw !== null) {
      for (const variant of strippedRaw) all.add(variant);
    }
  }
  for (const variant of normalized) {
    if (!variant.startsWith(prefix)) continue;
    for (const stripped of normalizeAlreadyDecodedPath(`/${variant.slice(prefix.length)}`)) {
      all.add(stripped);
    }
  }
  return [...all];
}

/**
 * Whether `rawUrl` uses a canonical root-relative pathname without repeated
 * slashes, dot segments, backslashes, encoded separators, or an encoded
 * `/@fs/` / `/@id/` prefix.
 */
export function isCanonicalViteRequestPath(rawUrl: string | undefined, base: string): boolean {
  if (rawUrl === undefined || !rawUrl.startsWith('/')) return false;
  const rawPath = rawUrl.replace(/[?#].*$/, '');
  if (rawPath.includes('//') || rawPath.includes('\\')) return false;
  if (NON_CANONICAL_SEGMENT.test(rawPath) || ENCODED_SEPARATOR.test(rawPath)) return false;

  const prefix = viteBasePrefix(base);
  const rawBelowBase = prefix !== '/' && rawPath.startsWith(prefix) ? `/${rawPath.slice(prefix.length)}` : rawPath;
  if (rawBelowBase.includes('//')) return false;

  let decodedBelowBase: string;
  try {
    decodedBelowBase = decodeURIComponent(rawBelowBase);
  } catch {
    return false;
  }
  if (decodedBelowBase.includes('\0') || decodedBelowBase.includes('\\')) return false;
  if (decodedBelowBase.startsWith(FS_PREFIX) && !rawBelowBase.startsWith(FS_PREFIX)) return false;
  if (decodedBelowBase.startsWith(ID_PREFIX) && !rawBelowBase.startsWith(ID_PREFIX)) return false;
  return true;
}

/**
 * The filesystem paths Vite could open for a decoded normalized pathname:
 * `/@id/` wrappers are stripped, `/@fs/` targets both the named filesystem
 * path and root-relative paths, and other paths are tried under each root
 * (plus directly as an absolute filesystem path when `includeAbsolute` is set).
 */
export function viteCandidateFiles(
  pathname: string,
  roots: readonly string[],
  options?: { readonly includeAbsolute?: boolean },
): string[] {
  let current = pathname;
  let unwrapCount = 0;
  while (current.startsWith(ID_PREFIX) && unwrapCount < MAX_ID_UNWRAPS) {
    current = `/${current.slice(ID_PREFIX.length).replace(/^\/+/, '')}`;
    unwrapCount += 1;
  }

  const files: string[] = [];
  if (current.startsWith(FS_PREFIX)) {
    const afterFs = current.slice(FS_PREFIX.length);
    if (WINDOWS_DRIVE_PATH.test(afterFs)) {
      files.push(afterFs);
    } else {
      files.push(`/${afterFs.replace(/^\/+/, '')}`);
    }
    for (const root of roots) {
      files.push(path.join(root, current));
    }
    return files;
  }

  if (options?.includeAbsolute === true) {
    files.push(current);
  }
  for (const root of roots) {
    files.push(path.join(root, current));
  }
  return files;
}
